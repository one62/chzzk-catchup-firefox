(() => {
  "use strict";

  // Firefox allows a single source node per element. Reuse it after bypassing.
  const sources = new WeakMap();
  let context;

  function filter(ctx, type, frequency) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = 0.707;
    return node;
  }

  function create(video, { useEffect, usePan }) {
    if (video.currentSrc && !video.crossOrigin && !video.srcObject &&
        new URL(video.currentSrc, location.href).origin !== location.origin) {
      throw new Error("이 외부 미디어의 오디오는 Web Audio로 처리할 수 없습니다.");
    }
    context ??= new AudioContext();
    const ctx = context;
    const nodes = [];
    if (useEffect) {
      const volume = ctx.createGain();
      volume.gain.value = 0.8;
      nodes.push(filter(ctx, "lowpass", 2750), filter(ctx, "highpass", 460), filter(ctx, "lowpass", 2500), volume);
    }
    if (usePan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = 0.55;
      nodes.push(pan);
    }
    let source;
    let disposed = false;

    function bypass() {
      for (const node of nodes) node.disconnect();
      if (source) {
        source.disconnect();
        source.connect(ctx.destination);
      }
    }

    function activate() {
      if (disposed || source || ctx.state !== "running") return;
      source = sources.get(video) ?? ctx.createMediaElementSource(video);
      sources.set(video, source);
      try {
        source.disconnect();
        let output = source;
        for (const node of nodes) output = output.connect(node);
        output.connect(ctx.destination);
      } catch (error) {
        bypass();
        throw error;
      }
    }

    function activateWhenReady() {
      try {
        activate();
      } catch (error) {
        console.warn("[CHZZK Catch-up] 생방송 음향 특수효과를 적용할 수 없습니다.", error);
      }
    }

    function resume() {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    }

    activate();
    ctx.addEventListener("statechange", activateWhenReady);
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("keydown", resume, true);
    resume();

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        ctx.removeEventListener("statechange", activateWhenReady);
        document.removeEventListener("pointerdown", resume, true);
        document.removeEventListener("keydown", resume, true);
        bypass();
      }
    };
  }

  globalThis.ClipAudioEffects = { create };
})();
