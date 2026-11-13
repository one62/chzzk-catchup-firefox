(function (root) {
  "use strict";

  const DEFAULT_MARGIN = 0.6;
  const DEFAULT_START = 3;
  const DEFAULT_RATE = 1.5;
  const RATES = [1.1, 1.2, 1.5, 2];
  const RATE_TOLERANCE = 0.001;
  const PROGRESS_TIMEOUT_MS = 4_000;

  function numeric(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizedMargin(value) {
    const number = numeric(value);
    if (number === null || number < 0.2 || number > 3) return DEFAULT_MARGIN;
    return Math.round((number + Number.EPSILON) * 10) / 10;
  }

  function normalizeSettings(raw = {}, margin = DEFAULT_MARGIN) {
    const source = raw && typeof raw === "object" ? raw : {};
    const minimumStart = Math.max(2, normalizedMargin(margin) + 0.5);
    const candidateStart = numeric(source.autoStart);
    const validStart = candidateStart !== null && candidateStart >= 2 && candidateStart <= 30
      ? candidateStart : DEFAULT_START;
    const autoStart = Math.max(minimumStart, Math.round((validStart + Number.EPSILON) * 10) / 10);
    const candidateRate = numeric(source.autoRate);
    return {
      autoEnabled: typeof source.autoEnabled === "boolean" ? source.autoEnabled : true,
      autoStart,
      autoRate: RATES.includes(candidateRate) ? candidateRate : DEFAULT_RATE,
    };
  }

  function stopBuffer(margin) {
    return Math.max(normalizedMargin(margin), 0.6);
  }

  function unavailableReason(state) {
    if (!state || state.isLive !== true) return "not-live";
    if (state.videoFound !== true) return "no-video";
    if (state.ended) return "ended";
    if (state.paused) return "paused";
    if (state.seeking) return "seeking";
    if (state.adState === "detected") return "ad";
    if (!Number.isFinite(state.readyState) || state.readyState < 3) return "not-ready";
    if (!Number.isFinite(state.currentTime) || state.currentTime < 0 ||
        !Number.isFinite(state.forwardBuffer) || state.forwardBuffer < 0) {
      return "invalid-timing";
    }
    return null;
  }

  function startDecision(state, settings, now, blockedUntil = 0, adaptiveStart) {
    const margin = normalizedMargin(settings?.margin ?? state?.margin);
    const normalized = normalizeSettings(settings, margin);
    if (!normalized.autoEnabled) return { start: false, reason: "disabled" };
    const unavailable = unavailableReason(state);
    if (unavailable) return { start: false, reason: unavailable };
    if (!Number.isFinite(now) || !Number.isFinite(blockedUntil)) {
      return { start: false, reason: "invalid-timing" };
    }
    if (now < blockedUntil) return { start: false, reason: "cooldown" };
    if (!Number.isFinite(state.playbackRate) ||
        Math.abs(state.playbackRate - 1) > RATE_TOLERANCE) {
      return { start: false, reason: "custom-rate" };
    }
    if (state.forwardBuffer < (adaptiveStart ?? normalized.autoStart)) {
      return { start: false, reason: "below-threshold" };
    }
    return { start: true, reason: "ready" };
  }

  function activeDecision(state, session, now) {
    const unavailable = unavailableReason(state);
    if (unavailable) return { stop: true, reason: unavailable };
    const requiredBuffer = session?.requiredBuffer ?? session?.margin;
    if (!session || !Number.isFinite(session.margin) || session.margin < 0.2 ||
        session.margin > 3 || !Number.isFinite(requiredBuffer) ||
        requiredBuffer < 0.2 || requiredBuffer > 30 || !Number.isFinite(session.startedAt) ||
        !Number.isFinite(session.lastProgressAt) || !Number.isFinite(now) ||
        now < session.startedAt || now < session.lastProgressAt) {
      return { stop: true, reason: "invalid-session" };
    }
    if (state.forwardBuffer <= requiredBuffer) {
      return { stop: true, reason: "target-reached" };
    }
    if (state.forwardBuffer <= stopBuffer(session.margin)) {
      return { stop: true, reason: "low-buffer" };
    }
    if (now - session.lastProgressAt >= PROGRESS_TIMEOUT_MS) {
      return { stop: true, reason: "no-progress" };
    }
    return { stop: false, reason: "catching-up" };
  }

  function adaptiveRate(buffer, required, maximum) {
    if (![buffer, required, maximum].every(Number.isFinite) || buffer <= required || maximum <= 1) return 1;
    // Spend surplus over roughly four seconds, tapering toward normal speed.
    return Math.min(maximum, Math.max(1.05, Math.floor((1 + (buffer - required) / 4) * 100) / 100));
  }

  const api = Object.freeze({ normalizeSettings, stopBuffer, startDecision, activeDecision, adaptiveRate });
  root.ChzzkCatchupAutoPolicy = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
