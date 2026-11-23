(() => {
  "use strict";

  if (!/^\/clip-editor\/?$/.test(location.pathname) || !window.opener) return;

  // The DOM opener is available even when Firefox opens the editor in a separate window.
  function notify(open) {
    window.opener?.postMessage({ type: "chzzk-clip-audio-editor", open }, location.origin);
  }

  window.addEventListener("pageshow", () => notify(true));
  window.addEventListener("pagehide", () => notify(false));
  notify(true);
})();
