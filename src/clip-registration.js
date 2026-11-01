"use strict";
const clipScript = {
  id: "clip-editor-compat",
  matches: ["https://chzzk.naver.com/clip-editor*"],
  js: ["src/clip-compat.js"],
  runAt: "document_start",
};
async function configureClip(enabled) {
  const filter = { ids: [clipScript.id] };
  const registered = await browser.scripting.getRegisteredContentScripts(filter);
  if (enabled && !registered.length) await browser.scripting.registerContentScripts([clipScript]);
  if (!enabled && registered.length) await browser.scripting.unregisterContentScripts(filter);
}
let pending = Promise.resolve();
function enqueue(task) {
  const result = pending.then(task);
  pending = result.catch(error => console.warn("[CHZZK Catch-up] Clip registration failed", error));
  return result;
}
function restore() {
  return enqueue(async () => {
    const { clipEnabled } = await browser.storage.local.get({ clipEnabled: true });
    await configureClip(clipEnabled);
  });
}
browser.runtime.onInstalled.addListener(restore);
browser.runtime.onStartup.addListener(restore);
browser.permissions.onAdded.addListener(restore);
browser.runtime.onMessage.addListener(message => {
  if (message?.type !== "configure-clip" || typeof message.enabled !== "boolean") return undefined;
  return enqueue(async () => {
    await configureClip(message.enabled);
    try {
      await browser.storage.local.set({ clipEnabled: message.enabled });
    } catch (error) {
      const { clipEnabled } = await browser.storage.local.get({ clipEnabled: true });
      await configureClip(clipEnabled);
      throw error;
    }
    return true;
  });
});
