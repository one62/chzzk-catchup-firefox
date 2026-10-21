(() => {
  "use strict";
  const MODES = ["auto", "hls", "llhls"];
  function normalize(raw = {}) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      streamMode: MODES.includes(raw.streamMode) ? raw.streamMode : "auto",
      bufferAutoEnabled: typeof raw.bufferAutoEnabled === "boolean" ? raw.bufferAutoEnabled
        : typeof raw.bufferGuardEnabled === "boolean" ? raw.bufferGuardEnabled : true,
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
