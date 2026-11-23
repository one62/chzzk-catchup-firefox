(() => {
  "use strict";

  function install(shouldPreventMute, findVideo, onOpen, onPreventedMute) {
    const page = window.wrappedJSObject;
    if (!page || typeof exportFunction !== "function") return;

    const open = page.open;
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
    if (!muted?.get || !muted.set || typeof open !== "function") return;

    function guardMute(video) {
      const element = video?.wrappedJSObject;
      if (!element || muted.get.call(video) || Object.hasOwn(element, "muted")) return;

      let installedSetter;
      function reset() {
        if (Object.getOwnPropertyDescriptor(element, "muted")?.set === installedSetter) delete element.muted;
      }
      const setMuted = exportFunction(value => {
        reset();
        // CHZZK mutes the live video synchronously after opening the clip popup.
        if (value === true) onPreventedMute(video);
        else muted.set.call(video, value);
      }, page);
      Object.defineProperty(element, "muted", {
        configurable: true,
        get: exportFunction(() => muted.get.call(video), page),
        set: setMuted,
      });
      installedSetter = Object.getOwnPropertyDescriptor(element, "muted").set;
      queueMicrotask(reset);
    }

    page.open = exportFunction(function (url, target) {
      const popup = Reflect.apply(open, this, arguments);
      if (!popup || target !== "chzzkClipEditor" || typeof url !== "string" || !url ||
          !shouldPreventMute()) return popup;
      try {
        const editor = new URL(url, document.baseURI);
        if (editor.origin !== location.origin || !/^\/clip-editor\/?$/.test(editor.pathname)) return popup;
        const video = findVideo();
        if (!video) return popup;
        onOpen(video);
        guardMute(video);
      } catch (error) {
        console.warn("[CHZZK Catch-up] 클립 편집기를 열 때 생방송 음소거를 막을 수 없습니다.", error);
      }
      return popup;
    }, page);
  }

  globalThis.ClipAudioOpen = { install };
})();
