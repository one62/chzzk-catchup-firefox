(() => {
  "use strict";
  const MODES = ["auto", "hls", "llhls"];
  function normalize(raw = {}) {
    const bounded = (value, min, max, fallback) => Number.isFinite(value) && value >= min && value <= max
      ? Math.round(value * 10) / 10 : fallback;
    return {
      streamMode: MODES.includes(raw.streamMode) ? raw.streamMode : "auto",
      bufferGuardEnabled: typeof raw.bufferGuardEnabled === "boolean" ? raw.bufferGuardEnabled : true,
      bufferGuardCount: Number.isInteger(raw.bufferGuardCount) && raw.bufferGuardCount >= 2 && raw.bufferGuardCount <= 5
        ? raw.bufferGuardCount : 2,
      bufferGuardStep: bounded(raw.bufferGuardStep, 0.1, 1, 0.2),
      bufferGuardMax: bounded(raw.bufferGuardMax, 0.2, 3, 3),
    };
  }
  function connectionLabel(kind) {
    return ({ main: "HLS", p2p: "HLS · P2P", "low-latency": "LL-HLS",
      "low-latency-p2p": "LL-HLS · P2P" })[kind] || "연결 확인 중";
  }
  function desiredKind(mode) { return mode === "hls" ? "main" : "low-latency"; }
  function matchesMode(kind, mode) {
    return mode === "hls" ? ["main", "p2p"].includes(kind)
      : ["low-latency", "low-latency-p2p"].includes(kind);
  }
  const api = Object.freeze({ normalize, connectionLabel, desiredKind, matchesMode });
  globalThis.ChzzkCatchupPlaybackPolicy = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
