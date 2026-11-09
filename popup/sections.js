(() => {
  const api = globalThis.browser || globalThis.chrome;
  const note = document.getElementById("feature-note");
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
    fold.disabled = true;
    const defaults = { [foldedKey]: false, [enabledKey]: key !== "chatLayout" };
    if (key === "chatLayout") defaults.chatLayoutWidth = 1000;
    api.storage.local.get(defaults).then(saved => {
      if (key === "chatLayout") {
        document.getElementById("chat-width").value = saved.chatLayoutWidth;
      }
      showFold(saved[foldedKey]);
      showEnabled(saved[enabledKey]);
      fold.disabled = toggle.disabled = false;
    }).catch(() => { note.textContent = "섹션 설정을 읽지 못했습니다."; });
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
  const width = document.getElementById("chat-width");
  const form = document.getElementById("chat-width-form");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!Number.isSafeInteger(width.valueAsNumber) || width.valueAsNumber < 1) return;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api.storage.local.set({ chatLayoutWidth: width.valueAsNumber });
      note.textContent = "채팅창 배치 기준 너비를 저장했습니다.";
    } catch {
      note.textContent = "채팅창 배치 기준 너비를 저장하지 못했습니다.";
    } finally {
      button.disabled = false;
    }
  });
})();
