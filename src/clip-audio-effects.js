(() => {
  "use strict";

  const PAN_AMOUNT = 0.4;
  // Firefox allows a single source node per element. Reuse it after bypassing.
  let sources = new WeakMap();
  let context;
  let hasSource = false;
  let activeEffects = 0;

  function panValue(side) {
    return side === "left" ? -PAN_AMOUNT : PAN_AMOUNT;
  }

  function onPageHide(event) {
    if (event?.persisted === false) closeContext();
  }

  function closeContext() {
    if (!context) return;
    const closing = context;
    context = undefined;
    hasSource = false;
    sources = new WeakMap();
    closing.removeEventListener("statechange", resumeWhenVisible);
    document.removeEventListener("pointerdown", resume, true);
    document.removeEventListener("keydown", resume, true);
    document.removeEventListener("visibilitychange", resumeWhenVisible);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("unload", closeContext);
    closing.close?.().catch?.(() => {});
  }

  function resume() {
    if (context && (hasSource || activeEffects > 0) && context.state === "suspended") {
      context.resume().catch(() => {});
    }
  }

  function resumeWhenVisible() {
    if (document.visibilityState === "visible") resume();
  }

  function getContext() {
    if (!context) {
      context = new AudioContext({ latencyHint: "playback" });
      // Bypassed media still uses this context while the editor window stays open.
      context.addEventListener("statechange", resumeWhenVisible);
      document.addEventListener("pointerdown", resume, true);
      document.addEventListener("keydown", resume, true);
      document.addEventListener("visibilitychange", resumeWhenVisible);
      window.addEventListener("pageshow", resume);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("unload", closeContext);
    }
    return context;
  }

  // Only allow verified same-origin sources (including same-origin MSE blob: URLs)
  // or MediaStream srcObject.
  function isSupportedSource(video) {
    if (!video) return false;
    if (video.srcObject) return true;
    if (!video.currentSrc) return false;
    try {
      return new URL(video.currentSrc, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function isReadyForPlayback(video) {
    return Boolean(video) && video.isConnected !== false && video.paused !== true &&
      !(typeof video.readyState === "number" && video.readyState < 1);
  }

  function checkSourceOrigin(video) {
    if (!isSupportedSource(video)) {
      throw new Error("이 외부 미디어의 오디오는 Web Audio로 처리할 수 없습니다.");
    }
  }

  function create(video, { side = "right", canAttach = () => true, onError, onCancel } = {}) {
    if (!isReadyForPlayback(video) || !canAttach()) {
      throw new Error("재생 준비가 완료되지 않은 미디어입니다.");
    }
    checkSourceOrigin(video);
    const ctx = getContext();
    const pan = ctx.createStereoPanner();
    pan.pan.value = panValue(side);
    let source;
    let disposed = false;

    function bypass() {
      pan.disconnect();
      if (source) {
        source.disconnect();
        source.connect(ctx.destination);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      activeEffects--;
      ctx.removeEventListener("statechange", activateWhenReady);
      bypass();
      if (!hasSource && activeEffects === 0) closeContext();
    }

    function activate() {
      if (disposed || source || ctx.state !== "running") return false;
      if (!isReadyForPlayback(video) || !canAttach()) {
        dispose();
        return false;
      }
      checkSourceOrigin(video);
      source = sources.get(video);
      if (!source) {
        source = ctx.createMediaElementSource(video);
        sources.set(video, source);
        hasSource = true;
      }
      try {
        source.disconnect();
        source.connect(pan).connect(ctx.destination);
      } catch (error) {
        bypass();
        throw error;
      }
      return true;
    }

    function activateWhenReady() {
      if (disposed) return;
      try {
        activate();
        if (disposed && !source) onCancel?.();
      } catch (error) {
        dispose();
        console.warn("[CHZZK Catch-up] 클립 편집기 음향 패닝을 적용할 수 없습니다.", error);
        onError?.(error);
      }
    }

    activeEffects++;
    try {
      activate();
    } catch (error) {
      dispose();
      throw error;
    }
    if (!disposed && !source) {
      ctx.addEventListener("statechange", activateWhenReady);
      resume();
    }

    return {
      setSide(nextSide) {
        if (!disposed) pan.pan.value = panValue(nextSide);
      },
      dispose,
    };
  }

  globalThis.ClipAudioEffects = { create, isSupportedSource };
})();
