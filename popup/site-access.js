(() => {
  "use strict";
  const api = globalThis.browser || globalThis.chrome;
  const button = document.getElementById("grant-chzzk-access");
  const status = document.getElementById("site-access-status");
  const scope = { origins: ["https://chzzk.naver.com/*"] };
  let requesting = false;
  let generation = 0;

  async function refresh() {
    const current = ++generation;
    button.disabled = true;
    try {
      const granted = await api.permissions.contains(scope);
      if (current !== generation || requesting) return;
      button.textContent = granted ? "치지직 접근 허용됨" : "치지직 접근 허용";
      button.disabled = granted;
    } catch {
      if (current !== generation || requesting) return;
      button.disabled = typeof api?.permissions?.request !== "function";
      status.textContent = "접근 권한 확인 실패";
    }
  }

  button.addEventListener("click", () => {
    if (requesting || button.disabled) return;
    requesting = true;
    ++generation;
    button.disabled = true;
    status.textContent = "Firefox에서 접근을 허용해 주세요.";
    let result;
    try {
      // Keep the permission request directly in the trusted click handler.
      result = api.permissions.request(scope);
    } catch {
      result = Promise.reject(new Error("Permission request failed"));
    }
    Promise.resolve(result).then(granted => {
      status.textContent = granted
        ? "방송을 새로고침하고 편집기를 다시 열어 주세요."
        : "접근이 허용되지 않았습니다.";
    }, () => {
      status.textContent = "접근 요청 실패 · Firefox 확장 설정을 확인해 주세요.";
    }).finally(() => {
      requesting = false;
      void refresh();
    });
  });
  api.permissions?.onAdded?.addListener(() => { void refresh(); });
  api.permissions?.onRemoved?.addListener(() => { void refresh(); });
  void refresh();
})();
