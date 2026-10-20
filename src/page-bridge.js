(() => {
  "use strict";
  // MAIN-world access to the official player; never expose raw player objects or URLs.
  const streams = globalThis.ChzzkCatchupPlayerStream.create({ document, window });
  const REQUEST = "chzzk-catchup-latency-request";
  const RESPONSE = "chzzk-catchup-latency-response";
  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        data?.namespace !== "chzzk-catchup-stream-request" ||
        typeof data.token !== "string" || data.token.length > 100 ||
        !Number.isSafeInteger(data.requestId) || !Number.isInteger(data.videoIndex) ||
        !["inspect", "switch"].includes(data.action) ||
        (data.action === "switch" && !["main", "low-latency"].includes(data.kind))) return;
    let result = { ok: false, reason: "not-live" };
    try {
      if (/^\/live\/[^/]+\/?$/.test(location.pathname)) {
        const video = document.querySelectorAll("video")[data.videoIndex];
        result = data.action === "inspect" ? { ok: true, stream: streams.inspect(video) }
          : await streams.change(video, data.kind);
      }
    } catch { result = { ok: false, reason: "player-unavailable" }; }
    window.postMessage({ namespace: "chzzk-catchup-stream-response", token: data.token,
      requestId: data.requestId, ...result }, location.origin);
  });
  window.addEventListener("pagehide", () => streams.destroy());
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.namespace !== REQUEST || typeof data.token !== "string" ||
        data.token.length > 100 || !Number.isSafeInteger(data.requestId)) return;
    let latency = null;
    if (/^\/live\/[^/]+\/?$/.test(location.pathname)) {
      try {
        const ms = window.__getLiveInfo?.()?.latency;
        if (Number.isFinite(ms) && ms >= 0 && ms <= 86400000) latency = ms / 1000;
      } catch {
        // Missing or temporarily invalid player metrics stay unknown.
      }
    }
    window.postMessage({ namespace: RESPONSE, token: data.token,
      requestId: data.requestId, latency }, location.origin);
  });
})();
