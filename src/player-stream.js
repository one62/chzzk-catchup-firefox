(() => {
  "use strict";
  const supportsKind = kind => ["main", "low-latency"].includes(kind);
  const text = value => typeof value === "string" ? value.slice(0, 120) : null;
  const number = value => Number.isFinite(value) ? value : null;
  function create({ window, now = () => performance.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    let busy = false, watched = null, partCount = 0, partAt = null, cached = null;
    const sourceIds = new WeakMap();
    let nextSourceId = 1, generation = 0;
    function matches(player, video) {
      try {
        return Boolean(player?.srcObject?.data?.media && player.videoTracks?.length &&
          (player._corePlayer?.player?.video === video || player.player?.video === video ||
            player.video === video || player.shadowRoot?.contains?.(video)));
      } catch { return false; }
    }
    function find(video) {
      if (!video?.isConnected) return null;
      if (matches(cached, video)) return cached;
      if (matches(window.__player, video)) return cached = window.__player;
      // The official facade is held in the live React component's useState.
      // Inspect only hook values along this video's ancestors; never serialize React state.
      const visited = new Set();
      for (let node = video, depth = 0; node && depth < 24; node = node.parentElement, depth++) {
        const key = Object.keys(node).find(key => key.startsWith("__reactFiber$"));
        let fiber = key ? node[key] : null;
        for (let level = 0; fiber && level < 24; fiber = fiber.return, level++) {
          if (visited.has(fiber)) continue;
          visited.add(fiber);
          let hook = fiber.memoizedState;
          for (let count = 0; hook && count < 100; hook = hook.next, count++) {
            if (matches(hook.memoizedState, video)) return cached = hook.memoizedState;
            if (matches(hook.memoizedState?.current, video)) return cached = hook.memoizedState.current;
          }
        }
      }
      return null;
    }
    function hlsOf(player) {
      try {
        const controller = (player._corePlayer || player).player?._mediaController;
        return controller?.getHlsInstance?.() || controller?._hls || null;
      } catch { return null; }
    }
    function onPart(_event, data) {
      if (data?.part) { partCount++; partAt = now(); }
    }
    function watch(hls) {
      if (watched === hls) return;
      watched?.off?.("hlsFragBuffered", onPart);
      watched = hls; partCount = 0; partAt = null;
      watched?.on?.("hlsFragBuffered", onPart);
    }
    function tracksOf(player) { return Array.from(player?.videoTracks || []).slice(0, 100); }
    function inspect(video) {
      const player = find(video);
      if (!player) { watch(null); return { available: false, reason: "player-unavailable" }; }
      const tracks = tracksOf(player), hls = hlsOf(player);
      watch(hls);
      const details = hls?.levels?.[hls.currentLevel]?.details || null;
      const selected = tracks.find(track => track.selected);
      if (!sourceIds.has(player.srcObject)) sourceIds.set(player.srcObject, nextSourceId++);
      return { available: true, sourceId: sourceIds.get(player.srcObject), busy,
        selectedKind: text(selected?.kind), selectedLabel: text(selected?.label),
        tracks: tracks.map(track => ({ id: text(track.id), kind: text(track.kind),
          label: text(track.label), width: number(track.width), height: number(track.height),
          selected: Boolean(track.selected) })),
        hls: hls ? { lowLatencyMode: typeof hls.lowLatencyMode === "boolean" ? hls.lowLatencyMode : null,
          partTarget: number(details?.partTarget), partHoldBack: number(details?.partHoldBack),
          canBlockReload: details?.canBlockReload ?? null,
          loadingParts: hls.streamController?.loadingParts ?? null,
          bufferedPartCount: partCount, lastPartBufferedAgoMs: partAt === null ? null : now() - partAt } : null };
    }
    function choose(tracks, previous, kind) {
      const candidates = tracks.filter(track => track.kind === kind);
      // Preserve the current quality/ABR choice; avoid switching to P2P.
      return candidates.find(track => track.label === previous?.label) ||
        candidates.find(track => track.width === previous?.width && track.height === previous?.height) ||
        candidates.find(track => track.label?.toUpperCase() === "ABR") || candidates[0];
    }
    async function change(video, kind = "low-latency") {
      if (!supportsKind(kind)) return { ok: false, reason: "invalid-kind" };
      if (busy) return { ok: false, reason: "busy" };
      const player = find(video), tracks = tracksOf(player);
      if (!player) return { ok: false, reason: "player-unavailable" };
      if (player.srcObject.data?.meta?.liveRewind) return { ok: false, reason: "not-playing" };
      const previous = tracks.find(track => track.selected);
      if (!previous) return { ok: false, reason: "track-unavailable" };
      const target = choose(tracks, previous, kind);
      if (!target) return { ok: false, reason: "track-unavailable" };
      if (previous === target) return { ok: true, reason: "already-selected", stream: inspect(video) };
      if (video.paused || video.seeking || video.ended || video.readyState < 2) return { ok: false, reason: "not-playing" };
      const source = player.srcObject;
      const attempt = generation;
      const deadline = now() + 12000;
      busy = true;
      try {
        target.selected = true;
        // Selection is synchronous, source preparation and media readiness are not.
        for (let count = 0; count < 48; count++) {
          await delay(250);
          if (attempt !== generation) return { ok: false, reason: "player-changed" };
          if (!video.isConnected || player.srcObject !== source || find(video) !== player) {
            return { ok: false, reason: "player-changed" };
          }
          if (!target.selected) return { ok: false, reason: "selection-changed" };
          if (now() >= deadline) throw new Error("timeout");
          if (video.error) throw new Error("media-error");
          if (video.readyState >= 3 && !video.seeking) {
            return { ok: true, reason: "selected", stream: inspect(video) };
          }
        }
        throw new Error("timeout");
      } catch {
        // Never override a user/site selection made during the attempt.
        let restored = false;
        if (attempt === generation && player.srcObject === source && target.selected && tracksOf(player).includes(previous)) {
          try { previous.selected = true; restored = previous.selected; } catch { /* report below */ }
        }
        return { ok: false, reason: "switch-failed", restored };
      } finally { if (attempt === generation) busy = false; }
    }
    return { inspect, change, destroy() { generation++; busy = false; watch(null); cached = null; } };
  }
  globalThis.ChzzkCatchupPlayerStream = { create };
})();
