(() => {
  "use strict";

  const WINDOW_MS = 5000;
  const MAX_AGE_MS = 2500;

  function create() {
    let samples = [];

    function reset() {
      samples = [];
    }

    function prune(now) {
      const last = samples.at(-1);
      if (!Number.isFinite(now) || !last || now < last.time || now - last.time > MAX_AGE_MS) {
        reset();
        return;
      }
      samples = samples.filter((sample) => sample.time > now - WINDOW_MS);
    }

    function add(value, now) {
      if (!Number.isFinite(value) || value < 0 || value > 86400 ||
          !Number.isFinite(now)) {
        reset();
        return;
      }
      prune(now);
      if (samples.at(-1)?.time === now) samples.pop();
      samples.push({ value, time: now });
      // Responses are normally one second apart; also bound unexpected bursts.
      if (samples.length > 64) samples.splice(0, samples.length - 64);
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
