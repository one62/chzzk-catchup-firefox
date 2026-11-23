(() => {
  "use strict";
  browser.runtime.onConnect.addListener(editor => {
    if (editor.name !== "clip-audio-editor") return;
    const sender = editor.sender;
    const opener = sender?.tab?.openerTabId;
    if (!Number.isInteger(opener) || sender.frameId !== 0 ||
        !/^https:\/\/chzzk\.naver\.com\/clip-editor\/?(?:[?#]|$)/.test(sender.url)) {
      editor.disconnect();
      return;
    }
    const live = browser.tabs.connect(opener, { name: "clip-audio-live", frameId: 0 });
    editor.onDisconnect.addListener(() => live.disconnect());
    live.onDisconnect.addListener(() => editor.disconnect());
  });
})();
