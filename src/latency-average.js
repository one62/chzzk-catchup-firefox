(() => {
  "use strict";

  const WINDOW_MS = 5000;
  const MAX_AGE_MS = 2500;

  function create() {
    let samples = [];
    let lastWallTime = null;
    let lastTime = null;

    function reset() {
      samples = [];
      lastWallTime = null;
      lastTime = null;
    }

    function prune(now) {
      const last = samples.at(-1);
      if (!Number.isFinite(now) || !last || now < last.time || now - last.time > MAX_AGE_MS) {
        reset();
        return;
      }
      samples = samples.filter((sample) => sample.time > now - WINDOW_MS);
    }

    function add(value, now, wallTime) {
      if (!Number.isFinite(value) || value < 0 || value > 86400 ||
          !Number.isFinite(now) || !Number.isFinite(wallTime)) {
        reset();
        return;
      }
      // Date.now() is part of CHZZK's measurement. A clock correction must not
      // be averaged together with samples measured against the old clock.
      if (lastTime !== null && (now < lastTime || now - lastTime > MAX_AGE_MS ||
          Math.abs((wallTime - lastWallTime) - (now - lastTime)) > 500)) reset();
      prune(now);
      if (samples.at(-1)?.time === now) samples.pop();
      samples.push({ value, time: now });
      // Responses are normally one second apart; also bound unexpected bursts.
      if (samples.length > 64) samples.splice(0, samples.length - 64);
      lastTime = now;
      lastWallTime = wallTime;
    }

    function get(now) {
      prune(now);
      return {
        value: samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : null,
        sampleCount: samples.length,
        windowSeconds: WINDOW_MS / 1000,
      };
    }

    return { add, get, reset };
  }

  const api = { create };
  globalThis.ChzzkCatchupLatencyAverage = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
