(() => {
  "use strict";

  const REFRESH_MS = 30000;
  const RETRY_MS = 10000;
  const MAX_AGE_MS = 90000;
  const MAX_RTT_MS = 1500;
  const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function create({ now = () => performance.now(), fetch: request = (...args) => globalThis.fetch(...args),
    location = globalThis.location, nonce = () => crypto.randomUUID(),
    setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout } = {}) {
    let path = null, clock = null, pending = null, nextAttempt = -Infinity;

    function reset() {
      if (pending) {
        clearTimer(pending.timer);
        pending.controller.abort();
      }
      pending = null;
      clock = null;
      path = null;
      nextAttempt = -Infinity;
    }

    async function refresh(started) {
      const attempt = { path, controller: new AbortController() };
      pending = attempt;
      nextAttempt = started + RETRY_MS;
      attempt.timer = setTimer(() => attempt.controller.abort(), 2000);
      try {
        const url = new URL(attempt.path, location.origin);
        url.searchParams.set("_chzzkCatchupClock", nonce());
        const response = await request(url.href, { method: "HEAD", cache: "no-store",
          credentials: "omit", redirect: "error", signal: attempt.controller.signal });
        const received = now(), elapsed = received - started;
        if (pending !== attempt || location.pathname !== attempt.path || attempt.controller.signal.aborted ||
            !response.ok || response.redirected || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_RTT_MS) return;
        if (response.url) {
          const returned = new URL(response.url);
          if (returned.origin !== location.origin || returned.pathname !== attempt.path) return;
        }
        const date = response.headers.get("Date"), age = response.headers.get("Age");
        if (!HTTP_DATE.test(date) || (age !== null && (!/^\d+$/.test(age) || Number(age) !== 0))) return;
        const utc = Date.parse(date);
        if (!Number.isFinite(utc)) return;
        // HTTP Date has whole-second precision. Use the middle of that second
        // and half the round trip as an estimate of the response travel time.
        clock = { utc: utc + 500 + elapsed / 2, at: received };
        nextAttempt = received + REFRESH_MS;
      } catch {
        // Missing headers, network failures and timeouts leave time unknown.
      } finally {
        clearTimer(attempt.timer);
        if (pending === attempt) pending = null;
      }
    }

    function read(video) {
      if (path !== location.pathname) { reset(); path = location.pathname; }
      if (!/^\/live\/[^/]+\/?$/.test(path) || !video?.isConnected || video.paused ||
          video.seeking || video.ended ||
          !Number.isFinite(video.currentTime) || video.currentTime < 0) return null;
      const time = now();
      if (!Number.isFinite(time)) return null;
      if (clock && (time < clock.at || time - clock.at > MAX_AGE_MS)) clock = null;
      if (!pending && time >= nextAttempt) void refresh(time);
      if (!clock) return null;
      const ingest = ingestAt(video);
      if (ingest === null) return null;
      const latency = (clock.utc + time - clock.at - ingest) / 1000;
      return Number.isFinite(latency) && latency >= 0 && latency <= 86400 ? latency : null;
    }

    return { read, reset };
  }

  function ingestAt(video) {
    let latest = null;
    try {
      const tracks = video.textTracks;
      for (let index = 0; index < Math.min(tracks?.length || 0, 32); index++) {
        const track = tracks[index];
        if (track.kind !== "metadata") continue;
        // Hidden metadata tracks populate activeCues without displaying text.
        if (track.mode === "disabled") track.mode = "hidden";
        const cues = track.activeCues;
        for (let cueIndex = 0; cueIndex < Math.min(cues?.length || 0, 64); cueIndex++) {
          const cue = cues[cueIndex];
          if (cue.value?.info !== "com.navercorp.nmss.timestamp" ||
              !Number.isFinite(cue.startTime) || cue.startTime < 0 ||
              !(cue.endTime > video.currentTime) || cue.startTime > video.currentTime) continue;
          try {
            const data = cue.value.data;
            if (!(ArrayBuffer.isView(data) || data instanceof ArrayBuffer) || data.byteLength > 8192) continue;
            const utc = JSON.parse(decoder.decode(data))["ingest-utc"];
            if (!Number.isFinite(utc) || utc <= 0) continue;
            if (!latest || cue.startTime > latest.start) latest = {
              start: cue.startTime, utc: utc + (video.currentTime - cue.startTime) * 1000 };
          } catch { /* A malformed cue must not hide another valid active cue. */ }
        }
      }
    } catch { return null; }
    return latest?.utc ?? null;
  }

  const api = { create };
  globalThis.ChzzkCatchupServerLatency = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
