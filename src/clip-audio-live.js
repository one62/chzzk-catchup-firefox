(() => {
  "use strict";

  const isEditor = pathname => /^\/clip-editor\/?$/.test(pathname);
  if (isEditor(location.pathname)) {
    // The main-world script handles editors with a DOM opener.
    if (window.opener) return;
    let port;
    function connect() {
      if (port || !isEditor(location.pathname)) return;
      port = browser.runtime.connect({ name: "clip-audio-editor" });
      port.onDisconnect.addListener(() => { port = null; });
    }
    window.addEventListener("pageshow", connect);
    window.addEventListener("pagehide", () => {
      port?.disconnect();
      port = null;
    });
    connect();
    return;
  }

  const editors = new Map();
  const clickSnapshotMs = 1200;
  const editorSnapshotMs = 20000;
  const media = globalThis.ChzzkCatchupMedia;
  const isLive = () => /^\/live\/[^/]+\/?$/.test(location.pathname);
  let keepAudio = false;
  let useEffect = false;
  let usePan = false;
  let settingsRevision = 0;
  let beforeOpen = null;
  let player = null;
  let engine = null;
  let failedVideo = null;
  let originalMuted = false;
  let nativeMuted = false;
  let writtenMute = null;
  let managingMute = false;
  let muteGraceUntil = 0;
  let timer = null;
  let path = location.pathname;
  let watchingClipOpen = false;

  const mainVideo = () => media.findMainVideo(player ??
    (beforeOpen?.path === location.pathname ? beforeOpen.video : null));

  function hasRecentSnapshot(video, time, maxAge) {
    return beforeOpen?.video === video && beforeOpen.path === location.pathname &&
      time - beforeOpen.time < maxAge;
  }

  // The site's click handler can mute the broadcast before the editor connects.
  function rememberMute(event) {
    if (!event.isTrusted || !isLive()) return;
    if (editors.size) {
      muteGraceUntil = 0;
      return;
    }
    const video = mainVideo();
    if (!video) return;
    const time = Date.now();
    if (beforeOpen?.opened && hasRecentSnapshot(video, time, editorSnapshotMs)) return;
    if (event.type === "click" && hasRecentSnapshot(video, time, clickSnapshotMs)) return;
    beforeOpen = { video, muted: video.muted, time, path: location.pathname };
  }
  window.addEventListener("pointerdown", rememberMute, true);
  window.addEventListener("keydown", rememberMute, true);
  window.addEventListener("click", rememberMute, true);

  // The popup can connect well after the gesture that opened it.
  function rememberClipOpen(video) {
    if (editors.size) return;
    const time = Date.now();
    const maxAge = beforeOpen?.opened ? editorSnapshotMs : clickSnapshotMs;
    beforeOpen = hasRecentSnapshot(video, time, maxAge)
      ? { ...beforeOpen, opened: true, time }
      : { video, muted: video.muted, opened: true, time, path: location.pathname };
  }

  function recordPreventedMute(video) {
    if (player === video && editors.size) {
      nativeMuted = true;
      writtenMute = false;
      return;
    }
    beforeOpen = { video, muted: false, opened: true, preventedMute: true, time: Date.now(),
      path: location.pathname };
  }

  document.addEventListener("volumechange", event => {
    if (event.target === player && writtenMute !== null && player.muted !== writtenMute &&
        Date.now() >= muteGraceUntil) writtenMute = null;
  }, true);

  function stopEffect() {
    engine?.dispose();
    engine = null;
    failedVideo = null;
  }

  function restoreMute(muted) {
    if (player && writtenMute !== null && player.muted === writtenMute) {
      player.muted = muted;
      writtenMute = muted;
    } else {
      writtenMute = null;
    }
    managingMute = false;
  }

  function setPlayer(next) {
    if (next === player) return;
    restoreMute(originalMuted);
    writtenMute = null;
    stopEffect();
    player = next;
    if (!player) return;
    const recentSnapshot = hasRecentSnapshot(player, Date.now(), editorSnapshotMs);
    const preventedMute = recentSnapshot && beforeOpen.preventedMute;
    nativeMuted = Boolean(preventedMute || player.muted);
    if (preventedMute && !player.muted) writtenMute = false;
    originalMuted = recentSnapshot ? beforeOpen.muted : nativeMuted;
  }

  function isEditorWindow(source) {
    try {
      return source && !source.closed && source.opener === window &&
        source.location.origin === location.origin && isEditor(source.location.pathname);
    } catch {
      return false;
    }
  }

  function endEditing() {
    const sessions = [...editors.values()];
    editors.clear();
    for (const session of sessions) session.disconnect?.();
    beforeOpen = null;
    setPlayer(null);
    clearInterval(timer);
    timer = null;
  }

  function refresh() {
    if (location.pathname !== path) {
      endEditing();
      path = location.pathname;
      return;
    }
    for (const [editor, session] of editors) {
      if (session.isOpen && !session.isOpen()) editors.delete(editor);
    }
    if (!editors.size) {
      endEditing();
      return;
    }

    setPlayer(mainVideo());
    if (!player) return;
    if (!keepAudio) {
      if (managingMute || writtenMute === false) restoreMute(nativeMuted);
      stopEffect();
      return;
    }
    if (!managingMute) {
      managingMute = true;
      muteGraceUntil = Date.now() + 2000;
    }
    if (player.muted && !originalMuted && Date.now() < muteGraceUntil) {
      nativeMuted = true;
      player.muted = false;
      writtenMute = false;
    }

    if ((!useEffect && !usePan) || engine || failedVideo === player || player.readyState < 1) return;
    try {
      engine = ClipAudioEffects.create(player, { useEffect, usePan });
    } catch (error) {
      failedVideo = player;
      console.warn("[CHZZK Catch-up] 생방송 음향 특수효과를 적용할 수 없습니다.", error);
    }
  }

  function addEditor(editor, session) {
    if (location.pathname !== path) {
      const snapshot = beforeOpen;
      endEditing();
      path = location.pathname;
      if (snapshot?.path === path) beforeOpen = snapshot;
    }
    editors.set(editor, session);
    if (!timer) timer = setInterval(refresh, 500);
    refresh();
  }

  function removeEditor(editor) {
    if (editors.delete(editor)) refresh();
  }

  window.addEventListener("message", event => {
    if (!isLive() || !event.isTrusted || event.origin !== location.origin ||
        event.data?.type !== "chzzk-clip-audio-editor") return;
    const editor = event.source;
    if (event.data.open === false) {
      removeEditor(editor);
    } else if (event.data.open === true && isEditorWindow(editor)) {
      addEditor(editor, { isOpen: () => isEditorWindow(editor) });
    }
  });
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== "clip-audio-live") return;
    if (!isLive()) { port.disconnect(); return; }
    port.onDisconnect.addListener(() => removeEditor(port));
    addEditor(port, { disconnect: () => port.disconnect() });
  });
  window.addEventListener("pagehide", endEditing);

  function loadSettings() {
    const revision = ++settingsRevision;
    browser.storage.local.get({ clipEnabled: true, clipKeepLiveAudio: false, clipLiveAudioEffect: false,
      clipLiveAudioPan: false }).then(settings => {
      if (revision !== settingsRevision) return;
      keepAudio = settings.clipEnabled !== false && settings.clipKeepLiveAudio === true;
      const nextEffect = settings.clipLiveAudioEffect === true;
      const nextPan = settings.clipLiveAudioPan === true;
      if (nextEffect !== useEffect || nextPan !== usePan) stopEffect();
      useEffect = nextEffect;
      usePan = nextPan;
      if (keepAudio && !watchingClipOpen) {
        ClipAudioOpen.install(() => keepAudio && isLive(), mainVideo, rememberClipOpen, recordPreventedMute);
        watchingClipOpen = true;
      }
      if (editors.size) refresh();
    }).catch(() => {});
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["clipEnabled", "clipKeepLiveAudio", "clipLiveAudioEffect", "clipLiveAudioPan"]
      .some(key => key in changes)) {
      loadSettings();
    }
  });
  loadSettings();
})();
