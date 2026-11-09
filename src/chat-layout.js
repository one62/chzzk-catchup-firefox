(() => {
  "use strict";

  const defaults = { chatLayoutEnabled: false, chatLayoutWidth: 1000 };
  const settings = { ...defaults };
  const chatSelector = "#aside-chatting, #vod-aside";
  const playerSelector = 'main > div > [class^="_player_"], #player_layout';
  const heightProperty = "--chzzk-catchup-chat-height";
  let viewport;
  let resizeObserver;
  let pageObserver;
  let frame;
  let player;
  let layout;

  function fitChatHeight() {
    frame = undefined;
    const chat = document.querySelector(
      '#layout-body #aside-chatting:not([class*="_is_folded_"]), #layout-body #vod-aside:has([role="log"])');
    const nextLayout = chat?.closest("#layout-body");
    const nextPlayer = chat?.parentElement.querySelector(playerSelector);
    if (layout !== nextLayout || player !== nextPlayer) {
      resizeObserver.disconnect();
      layout = nextLayout;
      player = nextPlayer;
      if (layout) resizeObserver.observe(layout);
      if (player) resizeObserver.observe(player);
    }

    const root = document.documentElement;
    if (!chat || !player || document.fullscreenElement) {
      root.style.removeProperty(heightProperty);
      return;
    }

    // Recover the panel's position at the top of the page, even if it is currently scrolled.
    let top = chat.getBoundingClientRect().top;
    for (let ancestor = chat.parentElement; ancestor; ancestor = ancestor.parentElement) {
      top += ancestor.scrollTop;
    }
    const available = root.clientHeight - top;
    if (available > 0) {
      root.style.setProperty(heightProperty, `${available}px`);
    } else {
      // If the video fills the window, leave chat available by scrolling down.
      root.style.removeProperty(heightProperty);
    }
  }

  function scheduleFit() {
    frame ??= requestAnimationFrame(fitChatHeight);
  }

  function updateLayout() {
    const active = settings.chatLayoutEnabled === true && viewport?.matches === true;
    const root = document.documentElement;
    root.toggleAttribute("data-chzzk-catchup-chat-below", active);
    if (active && !resizeObserver) {
      resizeObserver = new ResizeObserver(scheduleFit);
      pageObserver = new MutationObserver(records => {
        if (records.some(record => record.type === "attributes"
          ? record.target.matches(chatSelector)
          : !record.target.closest?.(chatSelector))) scheduleFit();
      });
      pageObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      window.addEventListener("resize", scheduleFit);
      document.addEventListener("fullscreenchange", scheduleFit);
      scheduleFit();
    } else if (!active && resizeObserver) {
      resizeObserver.disconnect();
      pageObserver.disconnect();
      resizeObserver = pageObserver = layout = player = undefined;
      window.removeEventListener("resize", scheduleFit);
      document.removeEventListener("fullscreenchange", scheduleFit);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      root.style.removeProperty(heightProperty);
    }
  }

  function watchViewport() {
    viewport?.removeEventListener("change", updateLayout);
    const width = settings.chatLayoutWidth;
    viewport = Number.isSafeInteger(width) && width > 0
      ? matchMedia(`(max-width: ${width}px)`) : null;
    viewport?.addEventListener("change", updateLayout);
    updateLayout();
  }

  const changedKeys = new Set();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(settings).filter(key => Object.hasOwn(changes, key));
    if (!keys.length) return;
    for (const key of keys) {
      changedKeys.add(key);
      settings[key] = changes[key].newValue ?? defaults[key];
    }
    watchViewport();
  });
  browser.storage.local.get(defaults).then(saved => {
    for (const key of Object.keys(settings)) {
      if (!changedKeys.has(key)) settings[key] = saved[key];
    }
    watchViewport();
  }).catch(() => {});
})();
