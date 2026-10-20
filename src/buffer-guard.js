(() => {
  "use strict";
  const WINDOW_MS = 60000;
  const MIN_STALL_MS = 250;
  function create() {
    let stalls = [], pending = null, raisedMargin = 0;
    function margin(base, settings) {
      return settings.bufferGuardEnabled ? Math.max(base, Math.min(raisedMargin, settings.bufferGuardMax)) : base;
    }
    function cancel() { pending = null; }
    function reset() { stalls = []; pending = null; raisedMargin = 0; }
    function begin(now) {
      if (Number.isFinite(now) && !pending) pending = { at: now, counted: false };
    }
    function tick(now, base, settings) {
      if (!settings.bufferGuardEnabled) { reset(); return null; }
      stalls = stalls.filter(at => now >= at && now - at < WINDOW_MS);
      if (!pending || pending.counted || now - pending.at < MIN_STALL_MS) return null;
      pending.counted = true;
      stalls.push(now);
      if (stalls.length < settings.bufferGuardCount) return null;
      const count = stalls.length;
      stalls = [];
      const from = margin(base, settings);
      const to = Math.max(from, Math.min(settings.bufferGuardMax,
        Math.round((from + settings.bufferGuardStep) * 10) / 10));
      if (to <= from) return null;
      raisedMargin = to;
      return { from, to, count, windowSeconds: WINDOW_MS / 1000 };
    }
    return { margin, begin, tick, cancel, reset };
  }
  const api = Object.freeze({ create });
  globalThis.ChzzkCatchupBufferGuard = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
