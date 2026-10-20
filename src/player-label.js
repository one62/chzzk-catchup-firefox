(() => {
  "use strict";

  const LABEL_CLASS = "chzzk-catchup-latency";
  const CONTROLS = ".pzp-pc__bottom-buttons-left, .pzp-pc__bottom-buttons-right";

  function findAnchor(video) {
    if (!video?.isConnected) return null;
    const player = video.closest(".pzp-pc") || video.closest(".pzp");
    if (!player) return null;
    for (const controls of player.querySelectorAll(CONTROLS)) {
      // CHZZK's native live badge is .live_time inside the bottom controls.
      // The public Chzzk-Platter source also uses this exact class as a native
      // anchor: src/audioMixer.js, PLAYER_BTN_ANCHOR_ORDER / resolveAnchorEl.
      const native = [...controls.querySelectorAll(".live_time")]
        .find((node) => !node.matches(`.${LABEL_CLASS}`)) ||
        [...controls.querySelectorAll(".pzp-pc__live-time, button, [role='button']")]
          .find((node) => !node.matches(`.${LABEL_CLASS}`) && /^(실시간|live)$/i.test(
            (node.textContent || "").trim() || (node.getAttribute("aria-label") || "").trim(),
          ));
      if (!native) continue;
      // A live badge may be nested in a button. Keep its clickable contents
      // intact and place our text after the whole native control instead.
      let anchor = native;
      while (anchor.parentElement && anchor.parentElement !== controls) {
        anchor = anchor.parentElement;
      }
      if (anchor.parentElement === controls) {
        return { player, controls, anchor, native,
          visibilityClass: native.matches(".live_time") ? "live_time" : "pzp-pc__live-time" };
      }
    }
    return null;
  }

  function applyTypography(label, native) {
    // Native LIVE text is 13px / 16px inside a 36px flex-centered button.
    // The bottom row also centers its flex items. Matching the text metrics
    // aligns our line box with it without a positional pixel correction.
    const nativeText = native.querySelector(".live_time_text, .pzp-live-time__text") || native;
    const style = native.ownerDocument.defaultView?.getComputedStyle?.(nativeText);
    if (!style) return;
    for (const property of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing"]) {
      if (style[property]) label.style[property] = style[property];
    }
  }

  function formatSeconds(value) {
    return Number.isFinite(value) && value >= 0 ? `${value.toFixed(2)}초` : "—";
  }

  function create({ getVideo, getLatency, getBuffer = () => null, getConnection = () => null }) {
    let label = null;
    let destroyed = false;

    function remove() {
      label?.remove();
      label = null;
    }

    function update() {
      if (destroyed) return;
      const target = findAnchor(getVideo());
      if (!target) {
        remove();
        return;
      }
      const { player, controls, anchor, native, visibilityClass } = target;
      if (label && label.parentElement !== controls) remove();
      if (!label) {
        label = controls.querySelector(`.${LABEL_CLASS}`) ||
          anchor.ownerDocument.createElement("span");
        label.title = "지연: 플레이어 측정값의 최근 5초 평균. 버퍼: 받아 둔 영상의 남은 시간.";
        label.style.cssText = "margin-inline-start:8px;" +
          "font:inherit;font-size:13px;line-height:16px;color:inherit;" +
          "white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums;flex-shrink:0";
      }
      applyTypography(label, native);
      for (const duplicate of player.querySelectorAll(`.${LABEL_CLASS}`)) {
        if (duplicate !== label) duplicate.remove();
      }
      // CHZZK fades individual controls, not their containing button row.
      // Its live_time (service CSS) / pzp-pc__live-time (vendor CSS) classes
      // change opacity with .pzp-pc--controls using the native .2s transition.
      // Sharing the anchor's visibility class also follows focus, auto-hide,
      // and fullscreen without a separate hover listener or timer. Keep
      // display/opacity/transition out of inline styles so native rules win.
      const className = `${LABEL_CLASS} ${visibilityClass}`;
      if (label.className !== className) label.className = className;
      if (anchor.nextSibling !== label) controls.insertBefore(label, anchor.nextSibling);
      const connection = getConnection();
      const text = `지연 ${formatSeconds(getLatency())} · 버퍼 ${formatSeconds(getBuffer())}` +
        (connection ? ` · ${connection}` : "");
      if (label.textContent !== text) label.textContent = text;
    }

    function destroy() {
      destroyed = true;
      remove();
    }

    return { update, destroy };
  }

  const api = { create };
  globalThis.ChzzkCatchupLabel = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
