(() => {
  "use strict";
  if (globalThis.__chzzkCatchupLoaded) return;
  globalThis.__chzzkCatchupLoaded = true;

  const media = globalThis.ChzzkCatchupMedia;
  const autoPolicy = globalThis.ChzzkCatchupAutoPolicy;
  const playbackPolicy = globalThis.ChzzkCatchupPlaybackPolicy;
  const bufferOptimizer = globalThis.ChzzkCatchupBufferOptimizer.create();
  const BUFFER_AUTO_FALLBACK_TARGET = 3;
  let playbackPreferences = {};
  let playbackSettings = playbackPolicy.normalize();
  let bufferIgnoreUntil = 0;
  let bufferDimensions = null;
  const latencyAverage = globalThis.ChzzkCatchupLatencyAverage.create();
  const monotonicNow = () => performance.now();
  const token = crypto.randomUUID();
  const videoEvents = ["waiting", "stalled", "playing", "pause", "seeking",
    "seeked", "emptied", "loadedmetadata", "ratechange", "error", "ended"];
  let margin = 0.6;
  let video = null;
  let path = location.pathname;
  let lastResult = null;
  let pendingSeek = null;
  let requestId = 0;
  let playerLatency = null;
  let latencyAt = 0;
  let displayedMetrics = null;
  let autoSettings = autoPolicy.normalizeSettings({}, margin);
  let settingsReady = false;
  let startupEnabled = true;
  let startupPending = true;
  let startupPlayback = null;
  let autoSession = null;
  let autoBlockedUntil = 0;
  let autoReason = null;
  let lastAutoStop = null;
  let waitingForPlayback = false;
  let sourceHasPlayed = false;
  let userRewound = false;
  let userSeekFrom = null;
  let lastPlaybackPosition = null;
  let pageSuspended = false;
  let stream = null;
  let streamBlockedUntil = 0;
  let streamFailures = 0;
  let streamEpoch = 0;
  let streamChanging = false;
  let streamResult = null;
  let streamRequestId = 0;
  let streamInspectedAt = -Infinity;
  let streamInspectPending = false;
  const streamRequests = new Map();
  const label = globalThis.ChzzkCatchupLabel.create({
    getVideo: () => isLive() ? video : null,
    getLatency: () => displayMetrics().playerLatency,
    getBuffer: () => displayMetrics().forwardBuffer,
    getConnection: () => playbackPolicy.connectionLabel(stream?.selectedKind),
  });
  const rateIndicator = globalThis.ChzzkCatchupRateIndicator.create({
    getVideo: () => isLive() && !pageSuspended ? video : null,
    getState: () => ({ active: Boolean(autoSession) && !waitingForPlayback,
      rate: autoSession?.rate ?? null }),
  });
  document.getElementById("chzzk-catchup-overlay")?.remove();

  function isLive() {
    return /^\/live\/[^/]+\/?$/.test(location.pathname);
  }

  function visible(element, box = element?.getBoundingClientRect()) {
    if (!element?.isConnected) return false;
    const css = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && css.display !== "none" &&
      css.visibility !== "hidden" && Number(css.opacity) !== 0;
  }

  function findVideo() {
    if (!isLive()) return null;
    let selected = null;
    let largestArea = 0;
    // Preview cards can coexist with the main player. Prefer the largest
    // visible video, and keep the current one when candidates have equal area.
    const candidates = [...document.querySelectorAll("video")];
    if (video && candidates.includes(video)) {
      candidates.splice(candidates.indexOf(video), 1);
      candidates.unshift(video);
    }
    for (const candidate of candidates) {
      const box = candidate.getBoundingClientRect();
      if (!visible(candidate, box)) continue;
      if (box.width < 160 || box.height < 90) continue;
      const area = box.width * box.height;
      if (area > largestArea) { selected = candidate; largestArea = area; }
    }
    return selected;
  }

  function adState() {
    if (!video) return "unknown";
    const player = video.closest(".pzp") || video.closest(".pzp-pc") || video.parentElement;
    if (!player) return "unknown";
    const markers = player.querySelectorAll(
      ".pzp-pc__ad, .pzp-pc__ad-container, .pzp-pc__ad-player, " +
      ".pzp-pc__ad-info, .pzp-pc__ad-break-indicator, " +
      ".pzp-pc__ad-click-through-button, [data-ad-state='playing']",
    );
    return [...markers].some(marker => visible(marker)) ? "detected" : "unknown";
  }

  // Keep the last displayed values across pause and latency-cache resets.
  function displayMetrics(state = media.snapshot(video)) {
    if (!video) return { playerLatency: null, forwardBuffer: null, edgeDistance: null };
    if (!video.paused || !displayedMetrics) {
      displayedMetrics = { playerLatency: latencyAverage.get(monotonicNow()).value,
        forwardBuffer: state.forwardBuffer, edgeDistance: state.edgeDistance };
    }
    return displayedMetrics;
  }

  function status() {
    const state = media.snapshot(video);
    const now = monotonicNow();
    const averagedLatency = latencyAverage.get(now);
    return { ...state, isLive: isLive(), videoFound: Boolean(video),
      ended: Boolean(video?.ended),
      seeking: state.seeking || Boolean(pendingSeek), margin, lastResult,
      ...displayMetrics(state),
      playerLatencyRaw: now - latencyAt <= 2500 ? playerLatency : null,
      latencyWindowSeconds: averagedLatency.windowSeconds,
      latencySampleCount: averagedLatency.sampleCount,
      adState: adState(),
      ...autoSettings, autoActive: Boolean(autoSession), autoReason, lastAutoStop,
      ...playbackSettings, effectiveMargin: effectiveMargin(),
      effectiveAutoStart: effectiveAutoSettings().autoStart,
      bufferOptimization: bufferOptimization(),
      connectionLabel: playbackPolicy.connectionLabel(stream?.selectedKind),
      autoStopBuffer: autoStopMargin(), startupEnabled,
      startupPending: startupEnabled && startupPending,
      stream, streamChanging, streamResult };
  }

  const autoMessages = {
    disabled: "자동 배속 따라잡기가 꺼져 있습니다.",
    "buffer-learning": "버퍼 보충 주기를 학습한 뒤 따라잡기를 시작합니다.",
    "buffer-unstable": "버퍼 보충 간격이 불안정해 따라잡기를 기다립니다.",
    "below-threshold": "연속 버퍼에 여유가 생기면 자동으로 배속 재생합니다.",
    cooldown: "다음 자동 따라잡기까지 잠시 기다립니다.",
    rewind: "되감기한 위치를 유지합니다. 즉시 따라잡기를 누르면 자동 동작이 다시 허용됩니다.",
    paused: "일시정지 중에는 자동으로 따라잡지 않습니다.",
    seeking: "재생 위치 이동 중에는 자동 배속을 멈춥니다.",
    ad: "광고 재생 중에는 자동 배속을 멈춥니다.",
    "low-buffer": "받아 둔 영상이 부족해 원래 속도로 재생합니다.",
    "invalid-timing": "영상 구간 정보를 기다리고 있습니다.",
    "not-ready": "영상이 준비되면 자동 따라잡기를 재개합니다.",
    "custom-rate": "직접 설정한 재생 속도를 유지합니다.",
    "target-reached": "설정한 여유에 도달해 원래 속도로 돌아왔습니다.",
    "no-progress": "4초 동안 재생 위치가 전진하지 않아 배속을 멈췄습니다.",
    waiting: "버퍼링 중에는 원래 속도로 재생합니다.",
    "rate-failed": "배속을 적용하지 못했습니다.",
  };

  function sameRate(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.001;
  }

  function resetLatency() {
    latencyAverage.reset();
    playerLatency = null;
    latencyAt = 0;
    requestId += 1;
  }

  function stopAuto(reason) {
    autoReason = autoMessages[reason] || null;
    if (!autoSession) return;
    const session = autoSession;
    autoSession = null;
    resetLatency();
    const stoppedAt = monotonicNow();
    autoBlockedUntil = Math.max(autoBlockedUntil, stoppedAt + 15000);
    let restored = false;
    try {
      // Restore only a rate still owned by this extension. A competing
      // extension or user choosing another rate retains their choice.
      if (sameRate(session.video.playbackRate, session.rate)) {
        session.video.playbackRate = session.originalRate;
        restored = true;
      }
    } catch {
      autoReason = "원래 재생 속도를 복구하지 못했습니다. 재생 속도를 확인해 주세요.";
    }
    lastAutoStop = { reason, message: autoReason, restored,
      durationSeconds: Math.max(0, stoppedAt - session.startedAt) / 1000 };
    rateIndicator.update();
  }

  function stepAuto() {
    if (pageSuspended) return;
    refreshVideo();
    stepBufferOptimizer();
    void inspectStream();
    if (!stream || streamChanging || stream.busy) {
      stopAuto("stream-priority");
      autoReason = "재생 경로를 확인하고 있습니다.";
      return;
    }
    if (!settingsReady) return;
    if (canPreferStream()) { void preferStream(); return; }
    if (stepStartup()) return;
    const state = status();
    const now = monotonicNow();
    const optimization = bufferOptimization(autoSession?.rate ?? autoSettings.autoRate, true);
    if (playbackSettings.bufferAutoEnabled && !optimization.playbackSafe && !autoSession) {
      stopAuto(optimization.phase === "learning" ? "buffer-learning" : "buffer-unstable");
      return;
    }
    if (autoSession) {
      if (!sameRate(state.playbackRate, autoSession.rate)) {
        stopAuto("custom-rate");
        autoBlockedUntil = Math.max(autoBlockedUntil, now + 30000);
        return;
      }
      // The download endpoint advances as chunks arrive. An unchanged (or
      // larger) buffer does not imply playback stopped. Watch decoded media
      // position for the stall watchdog; buffer still governs start/finish.
      if (Number.isFinite(state.currentTime) && state.currentTime - autoSession.lastProgressPosition >= 0.3) {
        autoSession.lastProgressPosition = state.currentTime;
        autoSession.lastProgressAt = now;
      }
      // Refresh the target as the next replenishment approaches; a target
      // captured only at session start becomes stale when a chunk arrives.
      if (playbackSettings.bufferAutoEnabled) {
        const requiredBuffer = optimization.playbackSafe
          ? optimization.requiredBuffer : BUFFER_AUTO_FALLBACK_TARGET;
        autoSession.margin = Math.min(3, requiredBuffer);
        autoSession.requiredBuffer = requiredBuffer;
      }
      const decision = autoPolicy.activeDecision(state, autoSession, now);
      if (decision.stop) stopAuto(decision.reason);
      return;
    }
    if (userRewound) { autoReason = autoMessages.rewind; return; }
    if (waitingForPlayback) { autoReason = autoMessages.waiting; return; }
    const decision = autoPolicy.startDecision(state,
      { ...effectiveAutoSettings(), margin: effectiveMargin() }, now, autoBlockedUntil);
    if (!decision.start) {
      autoReason = decision.reason === "cooldown" && lastAutoStop?.message
        ? `${lastAutoStop.message} ${autoMessages.cooldown}`
        : autoMessages[decision.reason] || null;
      return;
    }
    const requiredBuffer = playbackSettings.bufferAutoEnabled
      ? optimization.requiredBuffer : effectiveMargin();
    autoSession = { video, originalRate: state.playbackRate, rate: autoSettings.autoRate,
      margin: Math.min(3, requiredBuffer), requiredBuffer, startedAt: now,
      lastProgressAt: now, lastProgressPosition: state.currentTime };
    resetLatency();
    try {
      video.playbackRate = autoSession.rate;
      if (!sameRate(video.playbackRate, autoSession.rate)) { stopAuto("rate-failed"); return; }
      autoReason = null;
    } catch {
      stopAuto("rate-failed");
    }
  }

  function bufferOptimization(rate = autoSession?.originalRate ?? video?.playbackRate ?? 1, controlled = false) {
    return bufferOptimizer.status(monotonicNow(), margin, playbackSettings.bufferAutoEnabled, rate, controlled);
  }
  function effectiveMargin() { return bufferOptimization().margin; }
  function autoStopMargin(rate = autoSession?.rate ?? autoSettings.autoRate) {
    if (!playbackSettings.bufferAutoEnabled) return autoPolicy.stopBuffer(effectiveMargin());
    const optimization = bufferOptimization(rate, true);
    return optimization.playbackSafe ? optimization.requiredBuffer : BUFFER_AUTO_FALLBACK_TARGET;
  }
  function effectiveAutoSettings() {
    const target = autoStopMargin();
    const normalizedTarget = Math.min(3, Math.max(0.2, target));
    return autoPolicy.normalizeSettings({ ...autoSettings,
      autoStart: Math.max(autoSettings.autoStart, target + 0.5) }, normalizedTarget);
  }

  function canCountBuffering() {
    return settingsReady && playbackSettings.bufferAutoEnabled && isLive() && video &&
      sourceHasPlayed && !pageSuspended && !document.hidden && !video.paused && !video.ended &&
      !video.seeking && !pendingSeek && !streamChanging && !stream?.busy &&
      monotonicNow() >= bufferIgnoreUntil && adState() !== "detected";
  }

  function stepBufferOptimizer() {
    if (!canCountBuffering()) { bufferOptimizer.suspend(); return; }
    const dimensions = video.videoWidth > 0 && video.videoHeight > 0
      ? `${video.videoWidth}x${video.videoHeight}` : null;
    if (dimensions && bufferDimensions && dimensions !== bufferDimensions) {
      resetBufferOptimizer();
      stopAuto("source-changed");
      return;
    }
    if (dimensions) bufferDimensions = dimensions;
    bufferOptimizer.observe({ ...media.snapshot(video), waiting: waitingForPlayback }, monotonicNow());
  }

  function ignoreBuffering() {
    bufferOptimizer.suspend();
    bufferIgnoreUntil = monotonicNow() + 1000;
  }

  function resetBufferOptimizer() {
    bufferOptimizer.reset();
    bufferDimensions = null;
    ignoreBuffering();
  }

  function stepStartup() {
    if (!startupEnabled || !startupPending) return false;
    if (playbackSettings.bufferAutoEnabled && !bufferOptimization().safe) {
      const phase = bufferOptimization().phase;
      autoReason = autoMessages[phase === "learning" ? "buffer-learning" : "buffer-unstable"];
      startupPlayback = null;
      return true;
    }
    // Let the chosen stream actually play before moving. Reset readiness on
    // interruptions/source changes, but never re-arm a completed entry seek.
    if (!video || video.paused || video.ended || video.seeking || pendingSeek ||
        video.readyState < 3 || waitingForPlayback || userRewound ||
        stream?.busy || adState() === "detected") {
      startupPlayback = null;
      return true;
    }
    const buffer = media.forwardBuffer(video);
    const position = video.currentTime;
    if (!Number.isFinite(buffer) || !Number.isFinite(position)) {
      startupPlayback = null;
      return true;
    }
    const now = monotonicNow();
    if (!startupPlayback || startupPlayback.sourceId !== stream?.sourceId ||
        position < startupPlayback.position) {
      startupPlayback = { sourceId: stream?.sourceId, position, at: now };
      return true;
    }
    if (now - startupPlayback.at < 1000 || position - startupPlayback.position < 0.3) return true;
    startupPending = false;
    startupPlayback = null;
    if (buffer > effectiveMargin()) catchUp("startup");
    return true;
  }

  function finishSeek(reason) {
    if (!pendingSeek) return;
    const action = pendingSeek;
    clearTimeout(action.timer);
    pendingSeek = null;
    const actualCurrentTime = media.snapshot(video).currentTime;
    const targetDistance = actualCurrentTime === null ? null : actualCurrentTime - action.target;
    const reached = reason === "seeked" && targetDistance !== null && Math.abs(targetDistance) <= 0.5;
    lastResult = { message: reason === "seeked"
      ? reached ? "요청한 재생 위치 근처로 이동을 확인했습니다."
        : "위치는 이동했지만 요청한 목표에 도달했는지 확인하지 못했습니다."
      : reason === "timeout" ? "이동 완료 신호가 아직 없습니다. 재생 상태를 확인해 주세요."
      : "플레이어가 변경되어 이동 결과를 확인할 수 없습니다.",
      completed: reached, target: action.target, actualCurrentTime, targetDistance,
      requestedSkipSeconds: action.skipSeconds };
    render();
  }

  function onVideoEvent(event) {
    if (event.currentTarget !== video) return;
    if (event.type === "pause") displayMetrics();
    if (["emptied", "loadedmetadata", "ended", "error"].includes(event.type)) displayedMetrics = null;
    if (event.type === "waiting" && canCountBuffering()) bufferOptimizer.begin(monotonicNow());
    if (event.type === "playing") { stepBufferOptimizer(); bufferOptimizer.cancel(); }
    if (["pause", "seeking", "seeked", "emptied", "loadedmetadata", "ended", "error"].includes(event.type)) ignoreBuffering();
    if (["waiting", "pause", "playing", "seeking", "seeked", "ratechange",
      "ended", "error"].includes(event.type)) resetLatency();
    // stalled describes media fetching. Buffered playback can continue and
    // may not emit playing again; never latch waiting on this network event.
    // Real shortages are still handled by readyState/buffer in stepAuto().
    if (["waiting", "pause"].includes(event.type)) {
      startupPlayback = null;
      waitingForPlayback = true;
      stopAuto(event.type === "pause" ? "paused" : "waiting");
    }
    if (event.type === "playing") {
      waitingForPlayback = false;
      sourceHasPlayed = true;
    }
    if (event.type === "seeking" && !pendingSeek) {
      startupPlayback = null;
      // Track selection itself may seek while preparing the new stream.
      if (streamChanging) userSeekFrom = null;
      else {
        // Initial HLS preparation may seek to the live position before the
        // first frame. Only a seek after playback began cancels the entry action.
        if (sourceHasPlayed) startupPending = false;
        userSeekFrom = lastPlaybackPosition;
        autoBlockedUntil = Math.max(autoBlockedUntil, monotonicNow() + 30000);
        stopAuto("seeking");
      }
    }
    if (event.type === "seeked" && !pendingSeek) {
      const current = media.snapshot(video);
      if (Number.isFinite(userSeekFrom) && current.currentTime < userSeekFrom - 0.5) userRewound = true;
      if (Number.isFinite(current.edgeDistance) && current.edgeDistance <= effectiveMargin() + 0.5) userRewound = false;
      userSeekFrom = null;
    }
    if (event.type === "ratechange" && autoSession && !sameRate(video.playbackRate, autoSession.rate)) {
      stopAuto("custom-rate");
      autoBlockedUntil = Math.max(autoBlockedUntil, monotonicNow() + 30000);
    }
    if (["emptied", "loadedmetadata", "ended", "error"].includes(event.type)) stopAuto("source-changed");
    if (event.type === "emptied" || event.type === "loadedmetadata") {
      resetBufferOptimizer();
      startupPlayback = null;
      sourceHasPlayed = event.type === "loadedmetadata" && !video.paused && video.readyState >= 3;
      // A new source can reuse the same element while resetting its timeline.
      // Keep an existing DVR choice, but never compare it with the old clock.
      userSeekFrom = null;
      lastPlaybackPosition = media.snapshot(video).currentTime;
      waitingForPlayback = event.type === "emptied" || video.paused || video.readyState < 3;
      resetLatency();
      if (event.type === "emptied") finishSeek("source-changed");
    }
    if (event.type === "seeked") finishSeek("seeked");
    render();
  }

  function refreshVideo() {
    const nextPath = location.pathname;
    if (nextPath !== path) {
      resetStream();
      stopAuto("page-changed");
      finishSeek("page-changed");
      path = nextPath;
      displayedMetrics = null;
      resetBufferOptimizer();
      startupPending = true;
      startupPlayback = null;
      lastResult = null;
      lastAutoStop = null;
      resetLatency();
      userRewound = false;
      userSeekFrom = null;
      autoBlockedUntil = 0;
    }
    const next = findVideo();
    if (next === video) return;
    stopAuto("player-changed");
    finishSeek("player-changed");
    if (video) for (const name of videoEvents) video.removeEventListener(name, onVideoEvent);
    video = next;
    displayedMetrics = null;
    resetBufferOptimizer();
    startupPlayback = null;
    resetStream();
    lastAutoStop = null;
    resetLatency();
    waitingForPlayback = false;
    sourceHasPlayed = Boolean(video && !video.paused && video.readyState >= 3);
    userRewound = false;
    userSeekFrom = null;
    lastPlaybackPosition = video?.currentTime ?? null;
    autoBlockedUntil = 0;
    if (video) {
      for (const name of videoEvents) video.addEventListener(name, onVideoEvent);
    }
  }

  function readLatency() {
    if (!isLive() || !video || video.paused) return;
    requestId += 1;
    window.postMessage({ namespace: "chzzk-catchup-latency-request", token,
      requestId }, location.origin);
  }

  function requestStream(action, kind) {
    const selectedVideo = video;
    const id = ++streamRequestId;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        streamRequests.delete(id);
        resolve({ ok: false, reason: "bridge-timeout" });
      }, 15000);
      streamRequests.set(id, { selectedVideo, path: location.pathname, epoch: streamEpoch, timeout, resolve });
      window.postMessage({ namespace: "chzzk-catchup-stream-request", token, requestId: id,
        action, kind, videoIndex: [...document.querySelectorAll("video")].indexOf(video) }, location.origin);
    });
  }

  async function inspectStream() {
    if (pageSuspended || !isLive() || !video || streamChanging || streamInspectPending || monotonicNow() - streamInspectedAt < 1000) return;
    const epoch = streamEpoch;
    streamInspectedAt = monotonicNow();
    streamInspectPending = true;
    try {
      const result = await requestStream("inspect");
      if (!result.ok && epoch === streamEpoch) stream = { available: false, reason: result.reason };
    } finally { if (epoch === streamEpoch) streamInspectPending = false; }
  }

  function resetStream() {
    streamEpoch++;
    // Resolve obsolete requests now, rather than letting their 15s timeouts
    // hold up a new channel. Late responses no longer have a matching id.
    for (const request of streamRequests.values()) {
      clearTimeout(request.timeout);
      request.resolve({ ok: false, reason: "player-changed" });
    }
    streamRequests.clear();
    streamChanging = false;
    stream = null; streamResult = null;
    streamBlockedUntil = 0; streamFailures = 0;
    streamInspectedAt = -Infinity;
    streamInspectPending = false;
  }

  function canPreferStream() {
    const mode = playbackSettings.streamMode;
    return settingsReady && !pageSuspended && isLive() && video && !streamChanging &&
      !playbackPolicy.matchesMode(stream?.selectedKind, mode) &&
      stream?.tracks?.some(track => track.kind === playbackPolicy.desiredKind(mode)) &&
      monotonicNow() >= streamBlockedUntil &&
      !video.paused && !video.seeking && !video.ended && video.readyState >= 3 &&
      !pendingSeek && !userRewound && adState() !== "detected";
  }

  async function preferStream() {
    if (!canPreferStream()) return;
    const epoch = streamEpoch;
    const mode = playbackSettings.streamMode;
    const kind = playbackPolicy.desiredKind(mode);
    streamChanging = true;
    ignoreBuffering();
    startupPlayback = null;
    stopAuto("stream-switch");
    resetLatency();
    displayedMetrics = null;

    try {
      const response = await requestStream("switch", kind);
      if (epoch !== streamEpoch || mode !== playbackSettings.streamMode) return;
      if (response.ok) { streamFailures = 0; streamBlockedUntil = monotonicNow() + 5000; }
      else {
        streamFailures++;
        streamBlockedUntil = monotonicNow() + Math.min(300000, 60000 * 2 ** Math.min(streamFailures - 1, 3));
      }
      streamResult = { ok: response.ok, reason: response.reason,
        restored: response.restored, retryAfterSeconds: response.ok ? null : (streamBlockedUntil - monotonicNow()) / 1000 };
    } finally { if (epoch === streamEpoch) { streamChanging = false; ignoreBuffering(); render(); } }
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
      data?.namespace !== "chzzk-catchup-stream-response" || data.token !== token) return;
    const request = streamRequests.get(data.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    streamRequests.delete(data.requestId);
    if (request.selectedVideo !== video || request.path !== location.pathname || request.epoch !== streamEpoch) {
      request.resolve({ ok: false, reason: "player-changed" }); return;
    }
    if (data.stream && typeof data.stream === "object") {
      const next = cleanStream(data.stream);
      const selectedTrack = value => value?.tracks?.find(track => track.selected)?.id;
      if (stream && (stream.sourceId !== next.sourceId || stream.selectedKind !== next.selectedKind ||
          selectedTrack(stream) !== selectedTrack(next))) {
        resetBufferOptimizer();
        stopAuto("source-changed");
      }
      if (stream?.sourceId !== next.sourceId && next.sourceId !== null) {
        streamBlockedUntil = 0; streamFailures = 0;
      }
      stream = next;
    }
    request.resolve({ ok: data.ok === true, reason: data.reason, restored: data.restored === true });
  });

  function cleanStream(value) {
    const short = value => typeof value === "string" ? value.slice(0, 120) : null;
    const finite = value => Number.isFinite(value) ? value : null;
    const bool = value => typeof value === "boolean" ? value : null;
    return { available: value.available === true, reason: short(value.reason), sourceId: finite(value.sourceId),
      busy: value.busy === true,
      selectedKind: short(value.selectedKind), selectedLabel: short(value.selectedLabel),
      tracks: Array.isArray(value.tracks) ? value.tracks.slice(0, 100).map(track => ({
        id: short(track?.id), kind: short(track?.kind), label: short(track?.label),
        width: finite(track?.width), height: finite(track?.height), selected: track?.selected === true })) : [],
      hls: value.hls ? { lowLatencyMode: bool(value.hls.lowLatencyMode),
        partTarget: finite(value.hls.partTarget), partHoldBack: finite(value.hls.partHoldBack),
        canBlockReload: bool(value.hls.canBlockReload), loadingParts: bool(value.hls.loadingParts),
        bufferedPartCount: finite(value.hls.bufferedPartCount),
        lastPartBufferedAgoMs: finite(value.hls.lastPartBufferedAgoMs) } : null };
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        data?.namespace !== "chzzk-catchup-latency-response" ||
        data.token !== token || data.requestId !== requestId || !isLive() || !video || video.paused) return;
    playerLatency = Number.isFinite(data.latency) && data.latency >= 0 &&
      data.latency <= 86400 ? data.latency : null;
    latencyAt = monotonicNow();
    latencyAverage.add(playerLatency, latencyAt, Date.now());
    render();
  });

  function fail(message) {
    lastResult = { message, completed: false };
    render();
    return { ok: false, error: message, status: status() };
  }

  function catchUp(trigger = "manual") {
    refreshVideo();
    if (!isLive() || !video) return fail("치지직 라이브 재생 화면에서 사용해 주세요.");
    if (streamChanging) return fail("재생 전환이 끝난 뒤 다시 시도해 주세요.");
    if (pendingSeek) return fail("이전 위치 이동을 확인하는 중입니다.");
    if (adState() === "detected") return fail("광고 재생 중에는 따라잡지 않습니다.");
    // A chunk may have arrived since the 250ms control tick. Observe its
    // endpoint before seeking relative to that same, freshly buffered data.
    stepBufferOptimizer();
    if (playbackSettings.bufferAutoEnabled && !bufferOptimization().safe) {
      return fail(bufferOptimization().phase === "learning"
        ? "버퍼 보충 주기를 학습하는 중입니다. 학습이 끝난 뒤 다시 시도해 주세요."
        : "버퍼 보충 간격이 불안정합니다. 안정된 뒤 다시 시도해 주세요.");
    }
    const plan = media.planCatchUp(video, effectiveMargin());
    if (!plan.ok) return fail(plan.error);
    startupPending = false;
    startupPlayback = null;
    ignoreBuffering();
    stopAuto(`${trigger}-seek`);
    resetLatency();
    userRewound = false;
    userSeekFrom = null;
    autoBlockedUntil = Math.max(autoBlockedUntil, monotonicNow() + 15000);
    const action = { ...plan, timer: null };
    pendingSeek = action;
    lastResult = { message: `${plan.skipSeconds.toFixed(2)}초 앞으로 이동을 요청했습니다.`,
      completed: false, target: plan.target, requestedSkipSeconds: plan.skipSeconds };
    action.timer = setTimeout(() => finishSeek("timeout"), 5000);
    try {
      // Stay in the already downloaded, continuous range containing the
      // current position. Manual seeking never play()s or crosses a gap.
      video.currentTime = plan.target;
    } catch {
      clearTimeout(action.timer);
      pendingSeek = null;
      return fail("재생 위치를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    render();
    return { ok: true, status: status() };
  }

  function render() {
    displayMetrics();
    label.update();
    rateIndicator.update();
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.namespace !== "chzzk-catchup") return undefined;
    refreshVideo();
    if (message.type === "catch-up") return Promise.resolve(catchUp());
    if (message.type === "get-status") {
      void inspectStream();
      render();
      return Promise.resolve({ ok: true, status: status() });
    }
    if (message.type === "reset-buffer") {
      stopAuto("settings-changed");
      resetBufferOptimizer();
      return Promise.resolve({ ok: true, status: status() });
    }
    return Promise.resolve({ ok: false, error: "지원하지 않는 요청입니다." });
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !["margin", "startupEnabled", "autoEnabled", "autoStart", "autoRate",
      ...Object.keys(playbackSettings), "bufferGuardEnabled"].some((key) => changes[key])) return;
    stopAuto("settings-changed");
    if (changes.margin) margin = media.normalizeMargin(changes.margin.newValue);
    if (changes.startupEnabled) startupEnabled = changes.startupEnabled.newValue !== false;
    const nextPlayback = { ...playbackPreferences };
    for (const key of ["margin", "startupEnabled", "autoEnabled", "autoStart", "autoRate",
      ...Object.keys(playbackSettings), "bufferGuardEnabled"]) {
      if (changes[key]) nextPlayback[key] = changes[key].newValue;
    }
    playbackPreferences = nextPlayback;
    playbackSettings = playbackPolicy.normalize(nextPlayback);
    if (changes.streamMode) { streamBlockedUntil = 0; streamFailures = 0; streamResult = null; }
    if (changes.margin || changes.bufferAutoEnabled || changes.bufferGuardEnabled) resetBufferOptimizer();
    startupPlayback = null;
    autoSettings = autoPolicy.normalizeSettings(playbackPreferences, playbackSettings.bufferAutoEnabled ? 0.2 : margin);
    render();
  });

  const timer = setInterval(() => {
    if (pageSuspended) return;
    refreshVideo();
    void inspectStream();
    readLatency();
    render();
  }, 1000);
  const autoTimer = setInterval(() => {
    stepAuto();
    if (video && !video.seeking) lastPlaybackPosition = video.currentTime;
    render();
  }, 250);
  // BFCache freezes the page without unload. Restore the rate now, retaining
  // observers so returning to the same document still works.
  window.addEventListener("pagehide", () => {
    pageSuspended = true;
    ignoreBuffering();
    startupPlayback = null;
    resetStream();
    stopAuto("page-hidden");
    resetLatency();
    rateIndicator.update();
  });
  window.addEventListener("pageshow", () => {
    pageSuspended = false;
    refreshVideo();
    readLatency();
    render();
  });
  window.addEventListener("unload", () => {
    for (const request of streamRequests.values()) {
      clearTimeout(request.timeout);
      request.resolve({ ok: false, reason: "player-changed" });
    }
    streamRequests.clear();
    clearInterval(timer);
    clearInterval(autoTimer);
    stopAuto("unload");
    if (pendingSeek) clearTimeout(pendingSeek.timer);
    label.destroy();
    rateIndicator.destroy();
  }, { once: true });
  for (const name of ["resize", "scroll", "fullscreenchange", "visibilitychange"]) {
    (name === "resize" || name === "scroll" ? window : document)
      .addEventListener(name, render, { passive: true });
  }
  browser.storage.local.get({ margin: 0.6, startupEnabled: true, autoEnabled: true, autoStart: 3, autoRate: 1.5,
    streamMode: "auto", bufferAutoEnabled: null, bufferGuardEnabled: null }).then((saved) => {
    margin = media.normalizeMargin(saved.margin);
    startupEnabled = saved.startupEnabled !== false;
    playbackPreferences = saved;
    playbackSettings = playbackPolicy.normalize(saved);
    autoSettings = autoPolicy.normalizeSettings(saved, playbackSettings.bufferAutoEnabled ? 0.2 : margin);
    settingsReady = true;
    refreshVideo();
    readLatency();
    render();
  }).catch(() => {
    startupEnabled = false;
    autoSettings = autoPolicy.normalizeSettings({ autoEnabled: false }, margin);
    settingsReady = true;
    refreshVideo();
    render();
  });
})();
