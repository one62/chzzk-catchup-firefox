(() => {
  "use strict";

  const MIN_MARGIN = 0.6;
  const MAX_MARGIN = 3;
  const CONTROL_SECONDS = 0.25;
  const MIN_STALL_MS = 250;
  const MAX_OBSERVATION_GAP_MS = 1500;
  const MAX_IDLE_MS = 1000;
  const EDGE_EPSILON = 0.04;
  const MIN_SAMPLES = 6;
  const MAX_SAMPLES = 8;
  const DECAY_DELAY_MS = 30000;
  const DECAY_PER_SECOND = 0.005;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function create() {
    let samples = [], lastArrival = null, arrivalEdge = null, previous = null;
    let highWater = null, lastProgressAt = null, pending = null;
    let reserve = MIN_MARGIN, unsettled = false, stableSince = null, lastDecayAt = null;

    function clearLearning(unstable = false) {
      samples = [];
      lastArrival = null;
      arrivalEdge = null;
      stableSince = null;
      lastDecayAt = null;
      unsettled = unstable;
    }

    function suspend() {
      clearLearning();
      previous = null;
      highWater = null;
      lastProgressAt = null;
      pending = null;
    }

    function reset() {
      suspend();
      reserve = MIN_MARGIN;
    }

    function cancel() { pending = null; }

    function begin(now) {
      if (Number.isFinite(now) && pending === null) pending = { at: now, counted: false };
    }

    function estimate() {
      if (!samples.length) return null;
      const periods = samples.map(sample => sample.seconds);
      const period = median(periods);
      const jitter = Math.max(0.1, Math.max(...periods) - period,
        median(periods.map(value => Math.abs(value - period))) * 1.5);
      const spread = Math.max(...periods) - Math.min(...periods);
      // Adding currentTime to forwardBuffer removes playback-rate consumption.
      // Check received media too: tiny/huge append bursts do not establish a live cadence.
      const received = samples.reduce((sum, sample) => sum + sample.amount, 0);
      const elapsed = periods.reduce((sum, value) => sum + value, 0);
      const supplyRatio = received / elapsed;
      return { period, jitter, reliable: samples.length >= MIN_SAMPLES &&
        period >= 0.1 && period <= 12 && spread <= Math.max(0.5, period * 0.5) &&
        supplyRatio >= 0.5 && supplyRatio <= 2.5 };
    }

    function valid(state) {
      return state && Number.isFinite(state.currentTime) && state.currentTime >= 0 &&
        Number.isFinite(state.forwardBuffer) && state.forwardBuffer > 0 &&
        Number.isFinite(state.playbackRate) && state.playbackRate > 0 &&
        Number.isFinite(state.readyState) && state.readyState >= 2;
    }

    function seed(state, now, edge, unstable) {
      clearLearning(unstable);
      previous = { at: now, time: state.currentTime, edge, rate: state.playbackRate };
      highWater = highWater === null ? edge : Math.max(highWater, edge);
      lastProgressAt = now;
    }

    function observe(state, now) {
      if (!Number.isFinite(now)) {
        suspend();
        unsettled = true;
        return;
      }
      if (previous && now < previous.at) {
        suspend();
        unsettled = true;
      }
      if (state?.waiting) begin(now);
      if (pending && !pending.counted && now - pending.at >= MIN_STALL_MS) {
        pending.counted = true;
        reserve = Math.min(MAX_MARGIN, Math.max(reserve + 0.5, reserve * 1.35));
        clearLearning(true);
      }
      // Waiting may temporarily remove the current buffered range. The confirmed
      // stall above owns the reserve increase; duplicate events cannot raise it again.
      if (state?.waiting) return;
      if (!valid(state)) {
        clearLearning(true);
        previous = null;
        lastProgressAt = null;
        return;
      }

      const edge = state.currentTime + state.forwardBuffer;
      if (!Number.isFinite(edge)) {
        clearLearning(true);
        previous = null;
        return;
      }
      if (!previous) {
        seed(state, now, edge, unsettled);
        return;
      }
      if (now === previous.at) {
        // Coarse clocks can give two different media snapshots one timestamp.
        // Invalidate changed endpoints rather than reusing an obsolete phase.
        if (Math.abs(edge - previous.edge) > EDGE_EPSILON ||
            Math.abs(state.currentTime - previous.time) > EDGE_EPSILON) seed(state, now, edge, true);
        return;
      }

      const elapsed = (now - previous.at) / 1000;
      const advanced = state.currentTime - previous.time;
      const maxAdvance = elapsed * Math.max(previous.rate, state.playbackRate) * 1.8 + 0.25;
      if (elapsed * 1000 > MAX_OBSERVATION_GAP_MS || advanced < -EDGE_EPSILON ||
          advanced > maxAdvance || edge < previous.edge - EDGE_EPSILON) {
        seed(state, now, edge, true);
        return;
      }

      if (advanced > 0.001) lastProgressAt = now;
      const idle = now - lastProgressAt >= MAX_IDLE_MS;
      const appended = edge > highWater + EDGE_EPSILON;
      // A frozen playhead, or refilling a previously observed endpoint after a
      // range regression, must never be mistaken for a fresh periodic arrival.
      if (idle || (appended && advanced <= 0.001)) {
        seed(state, now, edge, true);
        return;
      }

      if (appended) {
        if (lastArrival !== null) {
          const seconds = (now - lastArrival) / 1000;
          const amount = edge - arrivalEdge;
          if (seconds >= 0.05 && amount > EDGE_EPSILON) {
            samples.push({ seconds, amount });
            if (samples.length > MAX_SAMPLES) samples.shift();
          } else {
            clearLearning(true);
          }
        }
        lastArrival = now;
        arrivalEdge = edge;
        highWater = edge;
      }
      previous = { at: now, time: state.currentTime, edge, rate: state.playbackRate };
      const prediction = estimate();
      const late = prediction && lastArrival !== null &&
        (now - lastArrival) / 1000 > prediction.period + prediction.jitter +
          Math.max(CONTROL_SECONDS, prediction.period * 0.25);
      if (prediction?.reliable && !late && pending === null) {
        if (stableSince === null) stableSince = now;
        if (lastDecayAt !== null && now - stableSince >= DECAY_DELAY_MS) {
          reserve = Math.max(MIN_MARGIN, reserve - (now - lastDecayAt) / 1000 * DECAY_PER_SECOND);
        }
        lastDecayAt = now;
      } else {
        stableSince = null;
        lastDecayAt = null;
      }
    }

    function status(now, manualMargin = MIN_MARGIN, enabled = true, rate = 1, controlled = false) {
      const prediction = estimate();
      const elapsed = lastArrival === null || !Number.isFinite(now)
        ? null : (now - lastArrival) / 1000;
      const remaining = prediction && elapsed !== null ? Math.max(0, prediction.period - elapsed) : null;
      const result = { margin: reserve, requiredBuffer: null, playbackSafe: false,
        phase: unsettled ? "unstable" : "learning",
        sampleCount: samples.length, periodSeconds: prediction?.period ?? null,
        jitterSeconds: prediction?.jitter ?? null, remainingSeconds: remaining, safe: false };
      if (!enabled) {
        result.margin = Number.isFinite(manualMargin) ? Math.min(MAX_MARGIN, Math.max(0.2, manualMargin)) : MIN_MARGIN;
        result.requiredBuffer = result.margin;
        result.phase = "manual";
        result.playbackSafe = true;
        result.safe = true;
        return result;
      }
      const fresh = Number.isFinite(now) && previous && now >= previous.at &&
        now - previous.at <= MAX_OBSERVATION_GAP_MS;
      const late = prediction && elapsed !== null && (elapsed < 0 || elapsed >
        prediction.period + prediction.jitter + Math.max(CONTROL_SECONDS, prediction.period * 0.25));
      if (!fresh || pending !== null || late || (prediction && !prediction.reliable && samples.length >= MIN_SAMPLES)) {
        result.phase = previous || unsettled || prediction ? "unstable" : "learning";
        return result;
      }
      if (!prediction?.reliable) return result;
      result.phase = "tracking";
      if (!Number.isFinite(rate) || rate <= 0) {
        result.phase = "unstable";
        return result;
      }
      // Continue at the selected speed for at most one control tick, then
      // allow a return to normal speed until the next expected append.
      // Charging the entire interval at the fast rate would reject healthy
      // streams at every replenishment, even when normal playback is safe.
      // A user's custom speed, which we do not own, needs the full interval.
      const consumption = controlled
        ? remaining + prediction.jitter + CONTROL_SECONDS * Math.max(1, rate)
        : (remaining + prediction.jitter + CONTROL_SECONDS) * rate;
      const needed = Math.max(reserve, consumption + reserve - MIN_MARGIN);
      result.margin = Math.min(MAX_MARGIN, Math.ceil((needed - Number.EPSILON) * 10) / 10);
      result.requiredBuffer = needed;
      // Automatic playback can use an existing buffer above the manual seek
      // target cap. `safe` still describes whether a seek can honor that cap.
      result.playbackSafe = true;
      result.safe = needed <= MAX_MARGIN;
      return result;
    }

    return { observe, begin, cancel, suspend, reset, status };
  }

  const api = Object.freeze({ create });
  globalThis.ChzzkCatchupBufferOptimizer = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
