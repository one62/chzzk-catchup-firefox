(() => {
  "use strict";
  const api = globalThis.browser || globalThis.chrome;
  const button = document.getElementById("grant-chzzk-access");
  const status = document.getElementById("site-access-status");
  const scope = { origins: ["https://chzzk.naver.com/*"] };
  const accessHelp = "치지직 기능을 사용하려면 사이트 접근을 허용해 주세요.";
  const checkFailed = "접근 권한 확인 실패";
  const reloadHelp = "열려 있는 치지직 탭을 새로고침해 주세요.";
  let requesting = false;
  let generation = 0;
  let previousGrant = null;

  async function refresh() {
    const current = ++generation;
    button.disabled = true;
    try {
      const granted = await api.permissions.contains(scope);
      if (current !== generation || requesting) return;
      button.textContent = granted ? "치지직 접근 허용됨" : "치지직 접근 허용";
      button.disabled = granted;
      if (!granted && (previousGrant === true || !status.textContent || status.textContent === checkFailed)) {
        status.textContent = accessHelp;
      } else if (granted && status.textContent !== reloadHelp) {
        status.textContent = "";
      }
      previousGrant = granted;
    } catch {
      if (current !== generation || requesting) return;
      button.disabled = typeof api?.permissions?.request !== "function";
      status.textContent = checkFailed;
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
        ? reloadHelp
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
