(() => {
  "use strict";

  const isEditor = pathname => /^\/clip-editor\/?$/.test(pathname);
  const media = globalThis.ChzzkCatchupMedia;

  // CHZZK opens the clip editor in its own window/tab. Keep Web Audio strictly
  // inside /clip-editor so live broadcast tabs stay on native audio playback.
  if (isEditor(location.pathname)) {
    let port = null;
    let usePan = false;
    let settingsRevision = 0;
    let pageHidden = false;
    let panVideo = null;
    let panSourceKey = null;
    let panEngine = null;
    let failedVideo = null;
    let failedSourceKey = null;

    function sourceKey(video) {
      return `${video?.currentSrc || ""}|${video?.srcObject ? "stream" : ""}`;
    }

    function disconnectPort() {
      port?.disconnect();
      port = null;
    }

    function connect() {
      // The main-world script handles editors with a DOM opener.
      if (pageHidden || window.opener || port || !isEditor(location.pathname)) return;
      port = browser.runtime.connect({ name: "clip-audio-editor" });
      port.onDisconnect.addListener(() => { port = null; });
    }

    function stopPan() {
      const active = panEngine;
      panEngine = null;
      panVideo = null;
      panSourceKey = null;
      active?.dispose();
      failedVideo = null;
      failedSourceKey = null;
    }

    function isSupportedSource(video) {
      return typeof ClipAudioEffects?.isSupportedSource === "function"
        ? ClipAudioEffects.isSupportedSource(video)
        : true;
    }

    function syncPan(event) {
      if (pageHidden || !usePan || !isEditor(location.pathname)) {
        if (panEngine || panVideo) stopPan();
        return;
      }
      if (event?.target === panVideo && panEngine && panVideo?.isConnected) {
        if (event.type === "emptied") {
          stopPan();
          return;
        }
        const key = sourceKey(panVideo);
        if (key === panSourceKey) return;
        if (!isSupportedSource(panVideo)) {
          const failed = panVideo;
          stopPan();
          failedVideo = failed;
          failedSourceKey = key;
          console.warn("[CHZZK Catch-up] 지원하지 않는 외부 미디어로 전환되어 클립 편집기 패닝을 중단합니다.");
          return;
        }
        panSourceKey = key;
        return;
      }
      const video = media.findMainVideo(panVideo);
      if (!video) {
        if (panEngine || panVideo) stopPan();
        return;
      }
      if (panEngine && video !== panVideo) stopPan();
      const key = sourceKey(video);
      if (!isSupportedSource(video)) {
        failedVideo = video;
        failedSourceKey = key;
        return;
      }
      if (panEngine) {
        panSourceKey = key;
        return;
      }
      if (video.readyState < 1 || video.paused === true) return;
      if (failedVideo === video && failedSourceKey === key) return;
      try {
        let settled = false;
        let created;
        created = ClipAudioEffects.create(video, {
          canAttach: () => !pageHidden && usePan && isEditor(location.pathname),
          onCancel() {
            settled = true;
            if (panEngine === created) {
              panEngine = null;
              panVideo = null;
              panSourceKey = null;
            }
          },
          onError() {
            settled = true;
            failedVideo = video;
            failedSourceKey = sourceKey(video);
            if (panEngine === created) {
              panEngine = null;
              panVideo = null;
              panSourceKey = null;
            }
          },
        });
        if (!settled) {
          panEngine = created;
          panVideo = video;
          panSourceKey = key;
          failedVideo = null;
          failedSourceKey = null;
        }
      } catch (error) {
        failedVideo = video;
        failedSourceKey = key;
        console.warn("[CHZZK Catch-up] 클립 편집기 음향 패닝을 적용할 수 없습니다.", error);
      }
    }

    function loadEditorSettings() {
      if (pageHidden) return;
      const revision = ++settingsRevision;
      browser.storage.local.get({
        clipEnabled: true, clipKeepLiveAudio: false, clipEditorAudioPan: false,
      }).then(settings => {
        if (pageHidden || revision !== settingsRevision) return;
        usePan = settings.clipEnabled !== false &&
          settings.clipKeepLiveAudio === true &&
          settings.clipEditorAudioPan === true;
        syncPan();
      }).catch(() => {});
    }

    for (const name of ["loadedmetadata", "canplay", "play", "playing", "emptied"]) {
      document.addEventListener(name, event => {
        if (name === "emptied" && event?.target === failedVideo) {
          failedVideo = null;
          failedSourceKey = null;
        }
        syncPan(event);
      }, true);
    }
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!["clipEnabled", "clipKeepLiveAudio", "clipEditorAudioPan"].some(key => key in changes)) return;
      const disabledByChange = (key, defaultTrue = false) => {
        const change = changes[key];
        if (!change || (!Object.hasOwn(change, "newValue") && !Object.hasOwn(change, "oldValue"))) return false;
        return defaultTrue ? change.newValue === false : change.newValue !== true;
      };
      if (disabledByChange("clipEnabled", true) ||
          disabledByChange("clipKeepLiveAudio") ||
          disabledByChange("clipEditorAudioPan")) {
        usePan = false;
        stopPan();
      }
      loadEditorSettings();
    });
    window.addEventListener("pageshow", () => {
      pageHidden = false;
      connect();
      loadEditorSettings();
    });
    window.addEventListener("pagehide", () => {
      pageHidden = true;
      usePan = false;
      settingsRevision++;
      stopPan();
      disconnectPort();
    });
    connect();
    loadEditorSettings();
    return;
  }

  const editors = new Map();
  const clickSnapshotMs = 1200;
  const editorSnapshotMs = 20000;
  const isLive = () => /^\/live\/[^/]+\/?$/.test(location.pathname);
  let keepAudio = false;
  let settingsRevision = 0;
  let beforeOpen = null;
  let player = null;
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

  function isEditableTarget(target) {
    if (!target || typeof target !== "object") return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function isActivationKey(key) {
    return key === "Enter" || key === " " || key === "Spacebar";
  }

  // The site's click handler can mute the broadcast before the editor connects.
  function rememberMute(event) {
    if (!event.isTrusted || !isLive()) return;
    if (editors.size) {
      muteGraceUntil = 0;
      return;
    }
    if (event.type === "keydown" && (isEditableTarget(event.target) || !isActivationKey(event.key))) {
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
    browser.storage.local.get({ clipEnabled: true, clipKeepLiveAudio: false }).then(settings => {
      if (revision !== settingsRevision) return;
      keepAudio = settings.clipEnabled !== false && settings.clipKeepLiveAudio === true;
      if (keepAudio && !watchingClipOpen) {
        ClipAudioOpen.install(() => keepAudio && isLive(), mainVideo, rememberClipOpen, recordPreventedMute);
        watchingClipOpen = true;
      }
      if (editors.size) refresh();
    }).catch(() => {});
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["clipEnabled", "clipKeepLiveAudio"].some(key => key in changes)) {
      loadSettings();
    }
  });
  loadSettings();
})();
