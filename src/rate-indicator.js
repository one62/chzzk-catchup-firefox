(() => {
  "use strict";

  const INDICATOR_CLASS = "chzzk-catchup-rate-indicator";

  function findTarget(video, state) {
    if (!video?.isConnected || !state?.active || !Number.isFinite(state.rate) ||
        state.rate <= 1 || Math.abs(video.playbackRate - state.rate) > 0.001 ||
        !Number.isFinite(video.playbackRate) || video.paused || video.ended ||
        video.seeking || video.readyState < 3) return null;
    const player = video.closest(".pzp-pc") || video.closest(".pzp");
    return player ? { video, player, rate: state.rate } : null;
  }

  function create({ getVideo, getState }) {
    let indicator = null;
    let mountedVideo = null;
    let destroyed = false;

    function remove() {
      indicator?.remove();
      indicator = null;
      mountedVideo = null;
    }

    function update() {
      if (destroyed) return;
      const target = findTarget(getVideo(), getState());
      if (!target) {
        remove();
        return;
      }
      const { video, player, rate } = target;
      if (indicator && (mountedVideo !== video || indicator.parentElement !== player)) remove();
      if (!indicator) {
        indicator = player.querySelector(`.${INDICATOR_CLASS}`) ||
          player.ownerDocument.createElement("span");
        indicator.className = INDICATOR_CLASS;
        indicator.setAttribute("aria-hidden", "true");
        indicator.title = "자동 배속 따라잡기 중";
        // The native player supplies the positioned coordinate container, also
        // in fullscreen. Keep this outside its fading bottom-control group.
        indicator.style.cssText = "position:absolute;right:20px;bottom:64px;z-index:10;" +
          "padding:5px 8px;border-radius:5px;background:rgba(0,0,0,.65);color:#fff;" +
          "font:600 13px/1.3 sans-serif;white-space:nowrap;pointer-events:none;" +
          "font-variant-numeric:tabular-nums;user-select:none";
        player.appendChild(indicator);
        mountedVideo = video;
      }
      for (const duplicate of player.querySelectorAll(`.${INDICATOR_CLASS}`)) {
        if (duplicate !== indicator) duplicate.remove();
      }
      const text = `>> ${Number(rate.toFixed(2))}×`;
      if (indicator.textContent !== text) indicator.textContent = text;
    }

    function destroy() {
      destroyed = true;
      remove();
    }

    return { update, destroy };
  }

  const api = { create };
  globalThis.ChzzkCatchupRateIndicator = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
