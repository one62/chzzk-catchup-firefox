(() => {
  const api = globalThis.browser || globalThis.chrome;
  const note = document.getElementById("feature-note");
  const width = document.getElementById("chat-width");
  const defaults = { chatLayoutWidth: 1000, clipKeepLiveAudio: false, clipLiveAudioEffect: false, clipLiveAudioPan: false };
  const apply = new Map();
  const readError = "섹션 설정을 읽지 못했습니다. 다시 시도 중입니다.";
  let savedWidth = 1000;
  let widthWrites = Promise.resolve();
  let ready = false;
  let pendingChanges = {};
  let retryTimer;

  const keepAudio = document.getElementById("clip-keep-live-audio");
  const audioControls = [
    ["clipKeepLiveAudio", keepAudio],
    ["clipLiveAudioEffect", document.getElementById("clip-live-audio-effect")],
    ["clipLiveAudioPan", document.getElementById("clip-live-audio-pan")],
  ];
  const audioSettings = {};
  const audioWrites = new Set();
  function renderAudioControls() {
    for (const [key, input] of audioControls) {
      input.checked = audioSettings[key] === true;
      input.disabled = audioWrites.has(key) || (input !== keepAudio && (keepAudio.disabled || !keepAudio.checked));
    }
  }
  for (const [key, input] of audioControls) {
    apply.set(key, value => {
      audioSettings[key] = value;
      renderAudioControls();
    });
    input.addEventListener("change", async () => {
      if (!ready || input.disabled) return;
      const enabled = input.checked;
      audioWrites.add(key);
      renderAudioControls();
      try {
        await api.storage.local.set({ [key]: enabled });
        audioSettings[key] = enabled;
        note.textContent = "";
      } catch {
        note.textContent = "생방송 오디오 설정을 저장하지 못했습니다.";
      } finally {
        audioWrites.delete(key);
        renderAudioControls();
      }
    });
  }

  apply.set("chatLayoutWidth", value => {
    savedWidth = value ?? defaults.chatLayoutWidth;
    if (document.activeElement !== width) width.value = savedWidth;
  });

  for (const key of ["catchup", "clip", "chatLayout"]) {
    const fold = document.getElementById(key + "-fold");
    const toggle = document.getElementById(key + "-enabled");
    const body = document.getElementById(key + "-body");
    const foldedKey = key + "Folded";
    const enabledKey = key + "Enabled";
    function showFold(folded) {
      body.hidden = folded;
      fold.setAttribute("aria-expanded", String(!folded));
    }
    function showEnabled(enabled) {
      toggle.checked = enabled;
      body.disabled = !enabled;
    }
    fold.disabled = toggle.disabled = true;
    defaults[foldedKey] = false;
    defaults[enabledKey] = key !== "chatLayout";
    apply.set(foldedKey, value => showFold(value ?? defaults[foldedKey]));
    apply.set(enabledKey, value => showEnabled(value ?? defaults[enabledKey]));
    fold.addEventListener("click", async () => {
      fold.disabled = true;
      try {
        const folded = !body.hidden;
        await api.storage.local.set({ [foldedKey]: folded });
        showFold(folded);
      } catch { note.textContent = "접기 설정을 저장하지 못했습니다."; }
      finally { fold.disabled = false; }
    });
    toggle.addEventListener("change", async () => {
      const enabled = toggle.checked;
      toggle.disabled = true;
      try {
        if (key === "clip") {
          await api.runtime.sendMessage({ type: "configure-clip", enabled });
          note.textContent = "열려 있는 클립 편집기는 새로고침하면 적용됩니다.";
        } else {
          await api.storage.local.set({ [enabledKey]: enabled });
          note.textContent = "";
        }
        showEnabled(enabled);
      } catch {
        showEnabled(!enabled);
        note.textContent = "기능 설정을 적용하지 못했습니다.";
      } finally { toggle.disabled = false; }
    });
  }
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, render] of apply) {
      if (!changes[key]) continue;
      if (ready) render(changes[key].newValue);
      else pendingChanges[key] = changes[key].newValue;
    }
  });
  function loadSections() {
    pendingChanges = {};
    api.storage.local.get(defaults).then(saved => {
      const settings = { ...saved, ...pendingChanges };
      for (const [key, render] of apply) render(settings[key]);
      for (const key of ["catchup", "clip", "chatLayout"]) {
        document.getElementById(key + "-fold").disabled = false;
        document.getElementById(key + "-enabled").disabled = false;
      }
      if (note.textContent === readError) note.textContent = "";
      ready = true;
    }).catch(() => {
      note.textContent = readError;
      retryTimer = setTimeout(loadSections, 1000);
    });
  }

  width.addEventListener("keydown", event => {
    if (event.key === "Enter") width.blur();
  });
  width.addEventListener("change", () => {
    if (!ready) return;
    const value = width.valueAsNumber;
    const valid = Number.isSafeInteger(value) && value >= 1;
    widthWrites = widthWrites.then(async () => {
      if (!valid) throw new Error("기준 너비는 1px 이상의 정수로 입력해 주세요.");
      await api.storage.local.set({ chatLayoutWidth: value });
      savedWidth = value;
      note.textContent = "";
    }).catch(error => {
      if (Object.is(width.valueAsNumber, value)) width.value = savedWidth;
      note.textContent = valid
        ? "채팅창 배치 기준 너비를 저장하지 못했습니다." : error.message;
    });
  });
  void loadSections();
  window.addEventListener("pagehide", () => clearTimeout(retryTimer), { once: true });
})();
