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
  const MAX_SAMPLES = 480;
  const HISTORY_MS = 120000;
  const RECENT_MS = 20000;
  const HORIZON = 3;
  const PROFILES = Object.freeze({
    low: Object.freeze({ reserve: 0.4, maxReserve: 2, stallStep: 0.3, maxWeight: 0.25 }),
    medium: Object.freeze({ reserve: 0.6, maxReserve: 3, stallStep: 0.5, maxWeight: 0.6 }),
    high: Object.freeze({ reserve: 1, maxReserve: 5, stallStep: 0.8, maxWeight: 1 }),
  });
  const DECAY_DELAY_MS = 30000;
  const DECAY_PER_SECOND = 0.005;

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function statistics(values) {
    if (!values.length) return null;
    return { min: Math.min(...values), max: Math.max(...values),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length };
  }

  function upperEstimate(values, weight) {
    const sorted = [...values].sort((a, b) => a - b);
    const upper = sorted[Math.ceil(sorted.length * 0.8) - 1];
    return upper + (sorted[sorted.length - 1] - upper) * weight;
  }

  function create(level = "medium") {
    let safetyLevel = Object.hasOwn(PROFILES, level) ? level : "medium";
    let profile = PROFILES[safetyLevel];
    let samples = [], lastArrival = null, arrivalEdge = null, previous = null;
    let freshSamples = 0, chain = 0;
    let highWater = null, lastProgressAt = null, pending = null;
    let reserve = profile.reserve, unsettled = false, stableSince = null, lastDecayAt = null;

    function clearLearning(unstable = false, keepHistory = false) {
      if (!keepHistory) samples = [];
      freshSamples = 0;
      chain++;
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
      reserve = profile.reserve;
    }

    function configure(level) {
      const next = Object.hasOwn(PROFILES, level) ? level : "medium";
      if (next === safetyLevel) return;
      safetyLevel = next;
      profile = PROFILES[next];
      reset();
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
      const recentIndex = samples.findIndex(sample => sample.at >= previous.at - RECENT_MS);
      const recent = samples.slice(Math.min(recentIndex < 0 ? samples.length : recentIndex,
        Math.max(0, samples.length - MIN_SAMPLES)));
      const supply = values => values.reduce((sum, sample) => sum + sample.amount, 0) /
        values.reduce((sum, sample) => sum + sample.seconds, 0);
      // Short-lived deterioration must not be hidden by a long healthy history.
      const supplyRatio = Math.min(supply(recent), supply(samples.slice(-MIN_SAMPLES)));
      return { period, jitter, recent, supplyRatio,
        intervalStats: statistics(periods), amountStats: statistics(samples.map(sample => sample.amount)),
        reliable: freshSamples >= MIN_SAMPLES && recent.length >= MIN_SAMPLES &&
          period >= 0.1 && period <= 12 && supplyRatio >= 0.9 && supplyRatio <= 2.5 };
    }

    function forecast(history, elapsed, rate) {
      const deficits = [];
      // Replay consecutive interval/amount pairs, including each pre-arrival trough.
      // Condition the first interval on the wait already observed. No wraparound:
      // joining unrelated ends of a trace invents a supply pattern.
      for (let start = 0; start <= history.length - HORIZON; start++) {
        if (history[start].chain !== history[start + HORIZON - 1].chain) continue;
        if (history[start].seconds + CONTROL_SECONDS <= elapsed) continue;
        let time = CONTROL_SECONDS - elapsed, received = 0, deficit = 0;
        for (let offset = 0; offset < HORIZON; offset++) {
          const sample = history[start + offset];
          time += sample.seconds;
          deficit = Math.max(deficit, time * rate - received);
          received += sample.amount;
        }
        deficits.push(deficit);
      }
      return deficits.length ? upperEstimate(deficits, profile.maxWeight) : null;
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
        reserve = Math.min(profile.maxReserve, Math.max(reserve + profile.stallStep, reserve * 1.35));
        clearLearning(true, true);
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
            samples.push({ seconds, amount, at: now, chain });
            freshSamples++;
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
      samples = samples.filter(sample => sample.at >= now - HISTORY_MS);
      const prediction = estimate();
      const late = prediction && lastArrival !== null &&
        (now - lastArrival) / 1000 >= prediction.intervalStats.max + CONTROL_SECONDS;
      if (prediction?.reliable && !late && pending === null) {
        if (stableSince === null) stableSince = now;
        if (lastDecayAt !== null && now - stableSince >= DECAY_DELAY_MS) {
          reserve = Math.max(profile.reserve, reserve - (now - lastDecayAt) / 1000 * DECAY_PER_SECOND);
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
      const residuals = prediction && elapsed !== null ? samples
        .filter(sample => sample.seconds + CONTROL_SECONDS > elapsed)
        .map(sample => sample.seconds + CONTROL_SECONDS - elapsed) : [];
      const remaining = residuals.length ? upperEstimate(residuals, profile.maxWeight) : null;
      const result = { margin: Math.min(MAX_MARGIN, reserve), requiredBuffer: null, playbackSafe: false,
        phase: unsettled ? "unstable" : "learning",
        sampleCount: samples.length, periodSeconds: prediction?.period ?? null,
        jitterSeconds: prediction?.jitter ?? null, remainingSeconds: remaining, safe: false,
        safetyLevel, reserveSeconds: reserve, intervalStats: prediction?.intervalStats ?? null,
        amountStats: prediction?.amountStats ?? null, supplyRatio: prediction?.supplyRatio ?? null,
        elapsedSinceArrival: elapsed };
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
      const late = prediction && elapsed !== null && (elapsed < 0 || remaining === null);
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
      // We can restore owned speed next tick; custom speed consumes at that
      // rate throughout the horizon. Never cap a required reserve to call it safe.
      const baseRate = controlled ? 1 : rate;
      const historical = forecast(samples, elapsed, baseRate);
      const recent = forecast(prediction.recent, elapsed, baseRate);
      if (historical === null) { result.phase = "unstable"; return result; }
      const needed = reserve + Math.max(historical, recent ?? 0) +
        (controlled ? CONTROL_SECONDS * Math.max(0, rate - 1) : 0);
      result.margin = Math.min(MAX_MARGIN, Math.ceil((needed - Number.EPSILON) * 10) / 10);
      result.requiredBuffer = needed;
      // Automatic playback can use an existing buffer above the manual seek
      // target cap. `safe` still describes whether a seek can honor that cap.
      result.playbackSafe = needed <= 29.5; // Leave the start hysteresis below the 30s setting limit.
      result.safe = needed <= MAX_MARGIN;
      return result;
    }

    return { observe, begin, cancel, suspend, reset, configure, status };
  }

  const api = Object.freeze({ create });
  globalThis.ChzzkCatchupBufferOptimizer = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
