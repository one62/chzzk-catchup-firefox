(() => {
  "use strict";
  if (globalThis.__chzzkCatchupLoaded) return;
  globalThis.__chzzkCatchupLoaded = true;

  const media = globalThis.ChzzkCatchupMedia;
  const autoPolicy = globalThis.ChzzkCatchupAutoPolicy;
  const playbackPolicy = globalThis.ChzzkCatchupPlaybackPolicy;
  const bufferGuard = globalThis.ChzzkCatchupBufferGuard.create();
  let playbackSettings = playbackPolicy.normalize();
  let guardIgnoreUntil = 0;
  let lastBufferAdjustment = null;
  const latencyAverage = globalThis.ChzzkCatchupLatencyAverage.create();
  const monotonicNow = () => performance.now();
  const MAX_LOG = 1200;
  const token = crypto.randomUUID();
  const samples = [];
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
    getLatency: () => latencyAverage.get(monotonicNow()).value,
    getBuffer: () => media.forwardBuffer(video),
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

  function status() {
    const state = media.snapshot(video);
    const now = monotonicNow();
    const averagedLatency = latencyAverage.get(now);
    return { ...state, isLive: isLive(), videoFound: Boolean(video),
      ended: Boolean(video?.ended),
      seeking: state.seeking || Boolean(pendingSeek), margin, lastResult,
      playerLatency: averagedLatency.value,
      playerLatencyRaw: now - latencyAt <= 2500 ? playerLatency : null,
      latencyWindowSeconds: averagedLatency.windowSeconds,
      latencySampleCount: averagedLatency.sampleCount,
      adState: adState(), sampleTime: new Date().toISOString(),
      ...autoSettings, autoActive: Boolean(autoSession), autoReason, lastAutoStop,
      ...playbackSettings, effectiveMargin: effectiveMargin(),
      effectiveAutoStart: effectiveAutoSettings().autoStart, lastBufferAdjustment,
      connectionLabel: playbackPolicy.connectionLabel(stream?.selectedKind),
      autoStopBuffer: autoPolicy.stopBuffer(effectiveMargin()), startupEnabled,
      startupPending: startupEnabled && startupPending,
      stream, streamChanging, streamResult };
  }

  const autoMessages = {
    disabled: "자동 배속 따라잡기가 꺼져 있습니다.",
    "buffer-adjusted": "끊김이 반복되어 남길 버퍼를 늘렸습니다.",
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
    record("auto-stopped", { reason, restored, durationSeconds: lastAutoStop.durationSeconds });
    rateIndicator.update();
  }

  function stepAuto() {
    if (pageSuspended) return;
    refreshVideo();
    stepBufferGuard();
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
    autoSession = { video, originalRate: state.playbackRate, rate: autoSettings.autoRate,
      margin: effectiveMargin(), startedAt: now, lastProgressAt: now, lastProgressPosition: state.currentTime };
    resetLatency();
    try {
      video.playbackRate = autoSession.rate;
      if (!sameRate(video.playbackRate, autoSession.rate)) { stopAuto("rate-failed"); return; }
      autoReason = null;
      record("auto-started");
    } catch {
      stopAuto("rate-failed");
    }
  }

  function effectiveMargin() { return bufferGuard.margin(margin, playbackSettings); }
  function effectiveAutoSettings() { return autoPolicy.normalizeSettings(autoSettings, effectiveMargin()); }

  function canCountBuffering() {
    return settingsReady && playbackSettings.bufferGuardEnabled && isLive() && video &&
      sourceHasPlayed && !pageSuspended && !video.paused && !video.ended &&
      !video.seeking && !pendingSeek && !streamChanging && !userRewound &&
      monotonicNow() >= guardIgnoreUntil && adState() !== "detected";
  }

  function stepBufferGuard() {
    if (!canCountBuffering()) { bufferGuard.cancel(); return; }
    const adjustment = bufferGuard.tick(monotonicNow(), margin, playbackSettings);
    if (!adjustment) return;
    lastBufferAdjustment = adjustment;
    stopAuto("buffer-adjusted");
    autoBlockedUntil = Math.max(autoBlockedUntil, monotonicNow() + 15000);
    record("buffer-increased", { adjustment });
  }

  function ignoreBuffering() {
    bufferGuard.cancel();
    guardIgnoreUntil = monotonicNow() + 1000;
  }

  function resetBufferGuard() {
    bufferGuard.reset();
    lastBufferAdjustment = null;
    ignoreBuffering();
  }

  function stepStartup() {
    if (!startupEnabled || !startupPending) return false;
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
    else record("startup-already-close");
    return true;
  }

  function record(type, details = {}) {
    samples.push({ type, path: location.pathname, ...status(), ...details });
    if (samples.length > MAX_LOG) samples.splice(0, samples.length - MAX_LOG);
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
    record(`catch-up-${reason}`, { requestedTarget: action.target,
      before: action.before, actionId: action.id, actualCurrentTime, targetDistance });
    render();
  }

  function onVideoEvent(event) {
    if (event.currentTarget !== video) return;
    if (event.type === "waiting" && canCountBuffering()) bufferGuard.begin(monotonicNow());
    if (event.type === "playing") { stepBufferGuard(); bufferGuard.cancel(); }
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
      if (Number.isFinite(current.edgeDistance) && current.edgeDistance <= margin + 0.5) userRewound = false;
      userSeekFrom = null;
    }
    if (event.type === "ratechange" && autoSession && !sameRate(video.playbackRate, autoSession.rate)) {
      stopAuto("custom-rate");
      autoBlockedUntil = Math.max(autoBlockedUntil, monotonicNow() + 30000);
    }
    if (["emptied", "loadedmetadata", "ended", "error"].includes(event.type)) stopAuto("source-changed");
    if (event.type === "emptied" || event.type === "loadedmetadata") {
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
    record(`media-${event.type}`);
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
      resetBufferGuard();
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
    ignoreBuffering();
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
      record("player-attached");
    }
  }

  function readLatency() {
    if (!isLive() || !video) return;
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
    record("stream-switch-request", { requestedKind: kind });
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
      record("stream-switch-result", { result: streamResult });
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
        data.token !== token || data.requestId !== requestId || !isLive() || !video) return;
    playerLatency = Number.isFinite(data.latency) && data.latency >= 0 &&
      data.latency <= 86400 ? data.latency : null;
    latencyAt = monotonicNow();
    latencyAverage.add(playerLatency, latencyAt, Date.now());
    render();
  });

  function fail(message) {
    lastResult = { message, completed: false };
    record("catch-up-blocked", { reason: message });
    render();
    return { ok: false, error: message, status: status() };
  }

  function catchUp(trigger = "manual") {
    refreshVideo();
    if (!isLive() || !video) return fail("치지직 라이브 재생 화면에서 사용해 주세요.");
    if (streamChanging) return fail("재생 전환이 끝난 뒤 다시 시도해 주세요.");
    if (pendingSeek) return fail("이전 위치 이동을 확인하는 중입니다.");
    if (adState() === "detected") return fail("광고 재생 중에는 따라잡지 않습니다.");
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
    const before = status();
    const action = { ...plan, before, id: crypto.randomUUID(), timer: null };
    pendingSeek = action;
    lastResult = { message: `${plan.skipSeconds.toFixed(2)}초 앞으로 이동을 요청했습니다.`,
      completed: false, target: plan.target, requestedSkipSeconds: plan.skipSeconds };
    record("catch-up-request", { actionId: action.id, trigger, plan, before });
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
      resetBufferGuard();
      record("buffer-reset");
      return Promise.resolve({ ok: true, status: status() });
    }
    if (message.type === "get-log") {
      return Promise.resolve({ ok: true, log: { schemaVersion: 1,
        extensionVersion: browser.runtime.getManifest().version,
        exportedAt: new Date().toISOString(), path: location.pathname,
        samples: samples.slice() } });
    }
    if (message.type === "clear-log") {
      samples.length = 0;
      return Promise.resolve({ ok: true, status: status() });
    }
    return Promise.resolve({ ok: false, error: "지원하지 않는 요청입니다." });
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !["margin", "startupEnabled", "autoEnabled", "autoStart", "autoRate",
      ...Object.keys(playbackSettings)].some((key) => changes[key])) return;
    stopAuto("settings-changed");
    if (changes.margin) margin = media.normalizeMargin(changes.margin.newValue);
    if (changes.startupEnabled) startupEnabled = changes.startupEnabled.newValue !== false;
    const nextPlayback = { ...playbackSettings };
    for (const key of Object.keys(playbackSettings)) {
      if (changes[key]) nextPlayback[key] = changes[key].newValue;
    }
    playbackSettings = playbackPolicy.normalize(nextPlayback);
    if (changes.streamMode) { streamBlockedUntil = 0; streamFailures = 0; streamResult = null; }
    if (changes.margin || ["bufferGuardEnabled", "bufferGuardCount", "bufferGuardStep", "bufferGuardMax"]
      .some(key => changes[key])) resetBufferGuard();
    startupPlayback = null;
    const next = { ...autoSettings };
    for (const key of ["autoEnabled", "autoStart", "autoRate"]) {
      if (changes[key]) next[key] = changes[key].newValue;
    }
    autoSettings = autoPolicy.normalizeSettings(next, margin);
    record("settings-changed");
    render();
  });

  const timer = setInterval(() => {
    if (pageSuspended) return;
    refreshVideo();
    void inspectStream();
    readLatency();
    if (isLive() && video) record("sample");
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
    ...playbackPolicy.normalize() }).then((saved) => {
    margin = media.normalizeMargin(saved.margin);
    startupEnabled = saved.startupEnabled !== false;
    autoSettings = autoPolicy.normalizeSettings(saved, margin);
    playbackSettings = playbackPolicy.normalize(saved);
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
