(() => {
  "use strict";
  // Run before the editor caches its browser detection result.
  if (location.origin !== "https://chzzk.naver.com" ||
      !/^\/clip-editor\/?$/.test(location.pathname)) return;

  try {
    const page = window.wrappedJSObject;
    if (!page || typeof exportFunction !== "function") {
      console.warn("[CHZZK Catch-up] Firefox page bridge is unavailable.");
      return;
    }
    // Compare page objects with each other, rather than with the sandbox global.
    if (page.top !== page) return;

    const original = navigator.userAgent;
    if (!/\bFirefox\/\d/.test(original) || /Android|Mobile|Tablet/i.test(original)) {
      return;
    }
    const platform = original.match(/^Mozilla\/5\.0 \(([^)]+)\)/)?.[1]
      ?.replace(/;\s*rv:[^;]+/g, "");
    if (!platform) return;

    const compatible = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36`;
    const pageNavigator = page.navigator;
    if (pageNavigator.userAgent === compatible) return;

    // Export only a constant-string getter; never expose extension APIs or use
    // page-supplied arguments. The isolated navigator keeps its native UA.
    Object.defineProperty(pageNavigator, "userAgent", {
      configurable: true,
      enumerable: true,
      get: exportFunction(() => compatible, window),
    });
    if (pageNavigator.userAgent !== compatible) throw new Error("Page UA verification failed");
  } catch (error) {
    console.warn("[CHZZK Catch-up] Could not enable clip editor compatibility.", error);
  }
})();
