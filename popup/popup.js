"use strict";

const api = globalThis.browser || globalThis.chrome;
const namespace = "chzzk-catchup";
const media = globalThis.ChzzkCatchupMedia;
const autoPolicy = globalThis.ChzzkCatchupAutoPolicy;
const playbackPolicy = globalThis.ChzzkCatchupPlaybackPolicy;
const settingKeys = ["margin", "startupEnabled", "autoEnabled", "autoStart", "autoRate",
  "bufferGuardEnabled", ...Object.keys(playbackPolicy.normalize())];
const elements = {
  badge: document.getElementById("state-badge"),
  latency: document.getElementById("player-latency"),
  edge: document.getElementById("edge-distance"),
  buffer: document.getElementById("forward-buffer"),
  margin: document.getElementById("margin"),
  marginHelp: document.getElementById("margin-help"),
  startupEnabled: document.getElementById("startup-enabled"),
  marginForm: document.getElementById("margin-form"),
  save: document.getElementById("save-margin"),
  autoForm: document.getElementById("auto-form"),
  autoEnabled: document.getElementById("auto-enabled"),
  autoStart: document.getElementById("auto-start"),
  autoRate: document.getElementById("auto-rate"),
  saveAuto: document.getElementById("save-auto"),
  catchUp: document.getElementById("catch-up"),
  feedback: document.getElementById("feedback"),
  connection: document.getElementById("current-connection"),
  streamStatus: document.getElementById("stream-status"),
  streamAuto: document.getElementById("stream-auto"),
  streamHls: document.getElementById("stream-hls"),
  streamLlhls: document.getElementById("stream-llhls"),
  bufferAutoForm: document.getElementById("buffer-auto-form"),
  bufferAutoEnabled: document.getElementById("buffer-auto-enabled"),
  saveBufferAuto: document.getElementById("save-buffer-auto"),
  bufferStatus: document.getElementById("buffer-status"),
  resetBuffer: document.getElementById("reset-buffer"),
};

let currentStatus = null;
let currentTabId = null;
let rawSettings = {};
let savedSettings = null;
let marginEdited = false;
let autoEdited = false;
let bufferAutoEdited = false;
let busy = false;
let refreshing = false;
let requestGeneration = 0;
let feedbackUntil = 0;

function seconds(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.max(0, value).toFixed(2)} 초`
    : "—";
}

function validMargin() {
  const value = elements.margin.valueAsNumber;
  return Number.isFinite(value) && value >= 0.2 && value <= 3;
}

function validAutoSettings() {
  const start = elements.autoStart.valueAsNumber;
  const margin = savedSettings?.margin ?? 0.6;
  const rate = Number(elements.autoRate.value);
  return Number.isFinite(start) && start >= 2 && start <= 30 &&
    (savedSettings?.bufferAutoEnabled || start >= margin + 0.5)
    && [1.1, 1.2, 1.5, 2].includes(rate);
}

function marginFitsAutoStart() {
  const start = savedSettings?.autoStart ?? 3;
  return start >= elements.margin.valueAsNumber + 0.5;
}

function manualMarginLocked() {
  return savedSettings?.bufferAutoEnabled || elements.bufferAutoEnabled.checked;
}

function optimizationWaiting(status) {
  return status?.bufferAutoEnabled === true && status.bufferOptimization?.safe === false;
}

function updateControls() {
  const settingsDisabled = busy || !savedSettings;
  const marginLocked = manualMarginLocked();
  elements.margin.disabled = settingsDisabled || marginLocked;
  elements.marginHelp.textContent = marginLocked
    ? "자동 최적화를 끄고 저장하면 남길 버퍼를 직접 설정할 수 있어요." : "";
  elements.startupEnabled.disabled = settingsDisabled;
  elements.save.disabled = settingsDisabled || !marginEdited ||
    (!marginLocked && (!validMargin() || !marginFitsAutoStart()));
  elements.autoEnabled.disabled = settingsDisabled;
  elements.autoStart.disabled = settingsDisabled;
  elements.autoRate.disabled = settingsDisabled;
  elements.saveAuto.disabled = settingsDisabled || !autoEdited || !validAutoSettings();
  for (const element of [elements.streamAuto, elements.streamHls, elements.streamLlhls,
    elements.bufferAutoEnabled]) element.disabled = settingsDisabled;
  elements.saveBufferAuto.disabled = settingsDisabled || !bufferAutoEdited;
  elements.resetBuffer.disabled = busy || !savedSettings?.bufferAutoEnabled || !currentStatus?.isLive;
  elements.catchUp.disabled =
    busy ||
    !currentStatus?.isLive ||
    !currentStatus.videoFound ||
    currentStatus.paused ||
    currentStatus.ended ||
    currentStatus.seeking ||
    currentStatus.streamChanging ||
    optimizationWaiting(currentStatus) ||
    currentStatus.adState === "detected";
}

function showFeedback(message, error = false, persistFor = 0) {
  elements.feedback.textContent = message;
  elements.feedback.classList.toggle("is-error", error);
  feedbackUntil = Date.now() + persistFor;
}

function statusMessage(status) {
  if (!status.isLive) return "라이브 탭에서 재생 상태 확인";
  if (!status.videoFound) return "방송 대기 중";
  if (status.adState === "detected") return "광고 재생 중";
  if (status.paused) return "일시정지";
  if (status.seeking) return "재생 위치 이동 중";
  if (status.ended) return "재생 종료";
  if (status.streamChanging) return "연결 전환 중";
  if (status.startupPending) return "입장 시 따라잡기 대기 중";
  if (status.autoActive) {
    const rate = Number.isFinite(status.playbackRate) ? status.playbackRate : (status.autoRate ?? 1.5);
    const stopBuffer = Number.isFinite(status.autoStopBuffer) ? status.autoStopBuffer
      : autoPolicy.stopBuffer(status.margin);
    return `${rate}배속으로 따라잡는 중 · 종료 기준 ${stopBuffer.toFixed(1)}초`;
  }
  if (optimizationWaiting(status)) {
    if (status.bufferOptimization.phase === "tracking") return "필요한 버퍼 여유가 줄어들 때까지 따라잡기 대기";
    return status.bufferOptimization.phase === "unstable"
      ? "보충 간격이 불안정해 따라잡기 대기" : "버퍼 보충 주기 학습 중";
  }
  if (status.autoEnabled === false) return "자동 배속 꺼짐";
  return "";
}

function renderStatus(status) {
  currentStatus = status;
  elements.latency.textContent = seconds(status.playerLatency);
  elements.edge.textContent = seconds(status.edgeDistance);
  elements.buffer.textContent = seconds(status.forwardBuffer);
  renderPlaybackInfo();
  const playing = status.isLive && status.videoFound && !status.paused && !status.seeking && !status.ended;
  elements.badge.classList.toggle("is-live", Boolean(playing));
  elements.badge.textContent = !status.isLive
    ? "라이브 아님"
    : !status.videoFound
      ? "준비 중"
      : status.adState === "detected"
        ? "광고 중"
        : status.paused
          ? "일시정지"
          : status.ended
            ? "재생 종료"
            : status.seeking
              ? "이동 중"
              : "LIVE";
  if (Date.now() >= feedbackUntil) showFeedback(statusMessage(status));
  updateControls();
}

function renderUnavailable(message) {
  currentStatus = null;
  elements.badge.textContent = "연결 안 됨";
  elements.badge.classList.remove("is-live");
  elements.latency.textContent = "—";
  elements.edge.textContent = "—";
  elements.buffer.textContent = "—";
  renderPlaybackInfo();
  if (Date.now() >= feedbackUntil) showFeedback(message);
  updateControls();
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Number.isInteger(tab.id)) throw new Error("현재 탭을 확인할 수 없어요.");
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    throw new Error("라이브 탭에서 재생 상태 확인");
  }
  if (url.origin !== "https://chzzk.naver.com") {
    throw new Error("라이브 탭에서 재생 상태 확인");
  }
  if (currentTabId !== tab.id) {
    currentTabId = tab.id;
    currentStatus = null;
  }
  return tab;
}

async function send(type, extra = {}) {
  const tab = await getActiveTab();
  let response;
  try {
    response = await api.tabs.sendMessage(tab.id, { namespace, type, ...extra });
  } catch {
    throw new Error("치지직 탭을 새로고침한 뒤 다시 열어 주세요.");
  }
  if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했어요.");
  return response;
}

async function refreshStatus() {
  if (busy || refreshing) return;
  refreshing = true;
  const generation = requestGeneration;
  try {
    const response = await send("get-status");
    if (generation !== requestGeneration) return;
    if (!response.status) throw new Error("재생 상태를 확인할 수 없어요.");
    renderStatus(response.status);
  } catch (error) {
    if (generation === requestGeneration) renderUnavailable(error.message);
  } finally {
    refreshing = false;
  }
}

async function performAction(action) {
  if (busy) return;
  busy = true;
  requestGeneration += 1;
  updateControls();
  try {
    await action();
  } catch (error) {
    showFeedback(error.message || "요청을 처리하지 못했어요.", true, 6000);
  } finally {
    busy = false;
    updateControls();
  }
}

function applySettings(raw) {
  rawSettings = { ...raw };
  const margin = media.normalizeMargin(raw.margin);
  const playback = playbackPolicy.normalize(raw);
  savedSettings = { margin, startupEnabled: raw.startupEnabled !== false,
    ...autoPolicy.normalizeSettings(raw, playback.bufferAutoEnabled ? 0.2 : margin), ...playback };
  renderSettings();
}

function renderSettings() {
  if (!savedSettings) return;
  if (!marginEdited) {
    elements.margin.value = String(savedSettings.margin);
    elements.startupEnabled.checked = savedSettings.startupEnabled;
  }
  if (!autoEdited) {
    elements.autoEnabled.checked = savedSettings.autoEnabled;
    elements.autoStart.value = String(savedSettings.autoStart);
    elements.autoRate.value = String(savedSettings.autoRate);
  }
  if (!bufferAutoEdited) elements.bufferAutoEnabled.checked = savedSettings.bufferAutoEnabled;
  for (const [button, mode] of [[elements.streamAuto, "auto"], [elements.streamHls, "hls"], [elements.streamLlhls, "llhls"]]) {
    button.setAttribute("aria-pressed", String(savedSettings.streamMode === mode));
  }
  renderPlaybackInfo();
  updateControls();
}

function renderPlaybackInfo() {
  const state = currentStatus;
  elements.connection.textContent = state?.videoFound ? playbackPolicy.connectionLabel(state.stream?.selectedKind) : "—";
  const mode = savedSettings?.streamMode ?? "auto";
  let info = "";
  if (state?.streamChanging) info = "전환 중";
  else if (state?.streamResult?.ok === false) info = "전환 실패 · 재시도 대기";
  else if (state?.stream?.available && !playbackPolicy.matchesMode(state.stream.selectedKind, mode)) {
    info = state.stream.tracks?.some(track => track.kind === playbackPolicy.desiredKind(mode))
      ? "연결 전환 대기" : "미지원 · 현재 연결 유지";
  }
  elements.streamStatus.textContent = info;
  if (!savedSettings?.bufferAutoEnabled) {
    elements.bufferStatus.textContent = `수동 남길 버퍼 ${(savedSettings?.margin ?? 0.6).toFixed(1)}초`;
    return;
  }
  if (!state?.isLive) {
    elements.bufferStatus.textContent = "방송 재생 중 버퍼 보충 주기를 학습합니다.";
    return;
  }
  const optimization = state.bufferOptimization;
  const phase = optimization?.phase;
  const details = [];
  if (phase === "tracking") details.push(state.autoActive && Number.isFinite(state.autoStopBuffer)
    ? `보충 주기 학습 완료 · 종료 기준 ${state.autoStopBuffer.toFixed(1)}초`
    : optimizationWaiting(state) ? "필요한 버퍼 여유가 줄어들 때까지 따라잡기 대기" : "보충 주기 학습 완료");
  else if (phase === "unstable") details.push(state.autoActive && Number.isFinite(state.autoStopBuffer)
    ? `보충 간격 재확인 중 · 종료 기준 ${state.autoStopBuffer.toFixed(1)}초`
    : "보충 간격이 불안정해 따라잡기 대기");
  else details.push("버퍼 보충 주기 학습 중");
  if (Number.isFinite(state.effectiveMargin)) details.push(`현재 남길 버퍼 ${state.effectiveMargin.toFixed(1)}초`);
  if (Number.isFinite(optimization?.periodSeconds)) details.push(`보충 주기 ${optimization.periodSeconds.toFixed(1)}초`);
  if (Number.isFinite(optimization?.jitterSeconds)) details.push(`변동 ${optimization.jitterSeconds.toFixed(1)}초`);
  if (Number.isFinite(state.effectiveAutoStart ?? state.autoStart)) {
    details.push(`배속 시작 ${(state.effectiveAutoStart ?? state.autoStart).toFixed(1)}초`);
  }
  elements.bufferStatus.textContent = details.join(" · ");
}

async function saveSettings(values) {
  try { await api.storage.local.set(values); }
  catch { throw new Error("설정을 저장하지 못했어요. 다시 시도해 주세요."); }
  applySettings({ ...rawSettings, ...values });
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !settingKeys.some(key => changes[key])) return;
  const next = { ...rawSettings };
  for (const key of settingKeys) {
    if (changes[key]) next[key] = changes[key].newValue;
  }
  applySettings(next);
});

for (const element of [elements.margin, elements.startupEnabled]) {
  element.addEventListener("input", () => {
    marginEdited = true;
    updateControls();
    if (!manualMarginLocked() && validMargin() && !marginFitsAutoStart()) {
      showFeedback("시작 버퍼를 먼저 높여 주세요. 남길 버퍼보다 0.5초 이상 커야 해요.", true, 6000);
    }
  });
}

for (const element of [elements.autoEnabled, elements.autoStart, elements.autoRate]) {
  element.addEventListener("input", () => {
    autoEdited = true;
    updateControls();
  });
}

elements.autoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!savedSettings) return;
  if (!validAutoSettings()) {
    showFeedback(savedSettings.bufferAutoEnabled ? "시작 버퍼는 2~30초, 배속은 목록에서 선택해 주세요."
      : "시작 버퍼는 2~30초이며 저장된 남길 버퍼보다 0.5초 이상 커야 해요.", true, 6000);
    return;
  }
  const settings = autoPolicy.normalizeSettings({
    autoEnabled: elements.autoEnabled.checked,
    autoStart: elements.autoStart.valueAsNumber,
    autoRate: Number(elements.autoRate.value),
  }, savedSettings.bufferAutoEnabled ? 0.2 : savedSettings.margin);
  void performAction(async () => {
    await saveSettings(settings);
    autoEdited = false;
    renderSettings();
    showFeedback("자동 배속 설정을 저장했어요.", false, 4000);
  });
});

elements.marginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!savedSettings) return;
  const marginLocked = manualMarginLocked();
  if (!marginLocked && !validMargin()) {
    showFeedback("남길 버퍼는 0.2~3초 사이로 입력해 주세요.", true, 6000);
    return;
  }
  if (!marginLocked && !marginFitsAutoStart()) {
    showFeedback("시작 버퍼를 먼저 높여 주세요. 남길 버퍼보다 0.5초 이상 커야 해요.", true, 6000);
    return;
  }
  const startupEnabled = elements.startupEnabled.checked;
  const values = { startupEnabled };
  if (!marginLocked) values.margin = media.normalizeMargin(elements.margin.valueAsNumber);
  void performAction(async () => {
    await saveSettings(values);
    marginEdited = false;
    renderSettings();
    const description = marginLocked ? "" : `남길 버퍼 ${values.margin.toFixed(1)}초 · `;
    showFeedback(`${description}입장 시 따라잡기 ${startupEnabled ? "켜짐" : "꺼짐"}으로 저장했어요.`, false, 4000);
  });
});

elements.catchUp.addEventListener("click", () => {
  if (elements.catchUp.disabled) return;
  void performAction(async () => {
    showFeedback("받아 둔 영상의 끝 가까이 이동하고 있어요.");
    const response = await send("catch-up");
    if (response.status) renderStatus(response.status);
    showFeedback(response.status?.lastResult?.message || "따라잡기를 실행했어요.", false, 4000);
  });
});

for (const [button, mode] of [[elements.streamAuto, "auto"], [elements.streamHls, "hls"], [elements.streamLlhls, "llhls"]]) {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    void performAction(async () => {
      await saveSettings({ streamMode: mode });
      showFeedback(`연결 방식을 ${mode === "auto" ? "자동" : mode === "hls" ? "HLS" : "LL-HLS"}로 저장했어요.`, false, 4000);
    });
  });
}

elements.bufferAutoEnabled.addEventListener("input", () => {
  bufferAutoEdited = true;
  updateControls();
});
elements.bufferAutoForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!savedSettings) return;
  const bufferAutoEnabled = elements.bufferAutoEnabled.checked;
  void performAction(async () => {
    await saveSettings({ bufferAutoEnabled });
    bufferAutoEdited = false;
    if (!bufferAutoEnabled) elements.margin.value = String(savedSettings.margin);
    renderSettings();
    showFeedback(`남길 버퍼 자동 최적화를 ${bufferAutoEnabled ? "켰어요" : "껐어요"}.`, false, 4000);
  });
});
elements.resetBuffer.addEventListener("click", () => {
  if (elements.resetBuffer.disabled) return;
  void performAction(async () => {
    const response = await send("reset-buffer");
    if (response.status) renderStatus(response.status);
    showFeedback("현재 방송의 버퍼 보충 주기 학습을 초기화했어요.", false, 4000);
  });
});

updateControls();
void api.storage.local.get(settingKeys).then(applySettings).catch(() => {
  showFeedback("설정을 읽지 못했어요. 확장 팝업을 다시 열어 주세요.", true, 6000);
});
void refreshStatus();
const refreshTimer = setInterval(() => void refreshStatus(), 1000);
window.addEventListener("pagehide", () => clearInterval(refreshTimer), { once: true });
