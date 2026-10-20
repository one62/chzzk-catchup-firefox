(function (root) {
  "use strict";

  const DEFAULT_MARGIN = 0.6;
  const MIN_MARGIN = 0.2;
  const MAX_MARGIN = 3;

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function readProperty(object, name) {
    try {
      return object?.[name];
    } catch {
      return undefined;
    }
  }

  function readRanges(ranges) {
    const result = [];
    const length = readProperty(ranges, "length");
    if (!Number.isInteger(length) || length < 0) return result;

    for (let index = 0; index < length; index += 1) {
      try {
        const start = ranges.start(index);
        const end = ranges.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          result.push([start, end]);
        }
      } catch {
        // A replaced media source can invalidate a range between reads.
      }
    }
    return result;
  }

  function validMargin(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < MIN_MARGIN || number > MAX_MARGIN) {
      return null;
    }
    return Math.round((number + Number.EPSILON) * 10) / 10;
  }

  function normalizeMargin(value, fallback = DEFAULT_MARGIN) {
    return validMargin(value) ?? validMargin(fallback) ?? DEFAULT_MARGIN;
  }

  function containingRange(ranges, time) {
    return Number.isFinite(time)
      ? ranges.find(([start, end]) => time >= start && time < end) : undefined;
  }

  function forwardBuffer(video) {
    const time = readProperty(video, "currentTime");
    const range = containingRange(readRanges(readProperty(video, "buffered")), time);
    return range ? range[1] - time : null;
  }

  function snapshot(video) {
    const currentTime = finiteOrNull(readProperty(video, "currentTime"));
    const seekable = readRanges(readProperty(video, "seekable"));
    const buffered = readRanges(readProperty(video, "buffered"));
    const finalSeekable = seekable[seekable.length - 1];
    const currentBuffer = containingRange(buffered, currentTime);
    let quality;
    try {
      quality = video?.getVideoPlaybackQuality?.();
    } catch {
      quality = undefined;
    }

    return {
      currentTime,
      paused: Boolean(readProperty(video, "paused")),
      seeking: Boolean(readProperty(video, "seeking")),
      readyState: finiteOrNull(readProperty(video, "readyState")),
      playbackRate: finiteOrNull(readProperty(video, "playbackRate")),
      seekable,
      buffered,
      edgeDistance: currentTime === null || !finalSeekable
        ? null : Math.max(0, finalSeekable[1] - currentTime),
      forwardBuffer: currentBuffer ? currentBuffer[1] - currentTime : null,
      droppedFrames: finiteOrNull(readProperty(quality, "droppedVideoFrames")),
      totalFrames: finiteOrNull(readProperty(quality, "totalVideoFrames")),
    };
  }

  function planCatchUp(video, margin) {
    const state = snapshot(video);
    if (readProperty(video, "ended")) {
      return { ok: false, error: "방송 재생이 종료되었습니다." };
    }
    if (state.paused) {
      return { ok: false, error: "일시정지 상태에서는 따라잡지 않습니다." };
    }
    if (state.seeking) {
      return { ok: false, error: "영상 위치를 이동하는 중입니다." };
    }
    if (state.readyState === null || state.readyState < 2) {
      return { ok: false, error: "영상을 준비하는 중입니다. 잠시 후 다시 시도해 주세요." };
    }
    if (state.currentTime === null) {
      return { ok: false, error: "현재 재생 위치를 확인할 수 없습니다." };
    }

    const currentRange = containingRange(state.buffered, state.currentTime);
    if (!currentRange) {
      return { ok: false, error: "현재 재생 위치에서 연속으로 이어지는 버퍼가 없습니다." };
    }

    const normalizedMargin = normalizeMargin(margin);
    const [start, edge] = currentRange;
    const target = Math.max(start, edge - normalizedMargin);
    if (target <= state.currentTime) {
      return { ok: false, error: "이미 설정한 목표 위치에 도달했습니다." };
    }

    return {
      ok: true,
      target,
      from: state.currentTime,
      edge,
      margin: normalizedMargin,
      source: "buffered",
      skipSeconds: target - state.currentTime,
    };
  }

  const api = Object.freeze({ readRanges, normalizeMargin, forwardBuffer, snapshot, planCatchUp });
  root.ChzzkCatchupMedia = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
