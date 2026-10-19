// Session telemetry: pure helpers shared by the guest page (derive a sample from getStats) and the sidecar (validate and log it).
// A sample is a window of counters turned into rates, so a 5 s sample says how the last 5 s felt, not the whole session.

export const SAMPLE_KEYS = Object.freeze([
  "windowMs", "fps", "frameJitterMs", "freezes", "freezeMs", "framesDropped", "jitterBufferMs",
  "packetsLost", "packetsReceived", "rttMs", "inputSends", "inputBufferedMax",
]);
const COUNTERS = ["framesDecoded", "framesDropped", "freezeCount", "totalFreezesDuration", "jitterBufferDelay", "jitterBufferEmittedCount", "packetsLost", "packetsReceived", "totalInterFrameDelay", "totalSquaredInterFrameDelay"];
const num = value => (Number.isFinite(value) ? value : 0);
const round = (value, places = 2) => (value == null ? null : Math.round(value * 10 ** places) / 10 ** places);

// Reduce an RTCStatsReport (anything with forEach) plus the page's own input counters to one flat snapshot.
export function snapshotStats(report, input = {}, now = Date.now()) {
  const snap = { at: now, rttMs: null, inputSends: num(input.sends), inputBuffered: num(input.buffered), hasVideo: false };
  for (const name of COUNTERS) snap[name] = 0;
  report.forEach(item => {
    if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated && Number.isFinite(item.currentRoundTripTime)) snap.rttMs = item.currentRoundTripTime * 1000;
    if (item.type === "inbound-rtp" && item.kind === "video") {
      snap.hasVideo = true;
      for (const name of COUNTERS) snap[name] = num(item[name]);
    }
  });
  return snap;
}

// Counter deltas between two snapshots. Returns null when there is no video yet or the window is empty.
// bufferedMax is the largest bufferedAmount seen inside the window (the caller tracks it between ticks).
export function diffSample(prev, cur, bufferedMax = cur.inputBuffered) {
  if (!prev || !cur?.hasVideo || !prev.hasVideo) return null;
  const windowMs = cur.at - prev.at;
  if (!(windowMs > 0)) return null;
  const d = name => Math.max(0, cur[name] - prev[name]);
  const frames = d("framesDecoded");
  let frameJitterMs = null;
  if (frames > 1) {
    const mean = d("totalInterFrameDelay") / frames;
    frameJitterMs = Math.sqrt(Math.max(0, d("totalSquaredInterFrameDelay") / frames - mean * mean)) * 1000;
  }
  const emitted = d("jitterBufferEmittedCount");
  return {
    windowMs,
    fps: round(frames / (windowMs / 1000), 1),
    frameJitterMs: round(frameJitterMs, 1),
    freezes: d("freezeCount"),
    freezeMs: Math.round(d("totalFreezesDuration") * 1000),
    framesDropped: d("framesDropped"),
    jitterBufferMs: emitted > 0 ? round(d("jitterBufferDelay") / emitted * 1000, 1) : null,
    packetsLost: d("packetsLost"),
    packetsReceived: d("packetsReceived"),
    rttMs: round(cur.rttMs, 1),
    inputSends: Math.max(0, cur.inputSends - prev.inputSends),
    inputBufferedMax: Math.max(0, bufferedMax),
  };
}

// Whitelist and bound an untrusted sample from a guest. Anything not a finite number (or null) is dropped.
export function sanitizeSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of SAMPLE_KEYS) {
    const value = raw[key];
    if (value === null) out[key] = null;
    else if (Number.isFinite(value)) out[key] = Math.max(-1e9, Math.min(1e9, round(value)));
  }
  return "fps" in out || "rttMs" in out ? out : null;
}

// One JSONL line. Carries the port number and a timestamp only.
export function telemetryLine(port, sample, at = Date.now()) {
  return `${JSON.stringify({ at: new Date(at).toISOString(), port, ...sample })}\n`;
}

// Text for the live overlay.
export function overlayText(sample) {
  if (!sample) return "stats: waiting for video";
  const f = (v, unit = "", places = 0) => (v == null ? "--" : `${Number(v.toFixed(places))}${unit}`);
  return [
    `fps ${f(sample.fps, "", 1)}  jitter ${f(sample.frameJitterMs, " ms", 1)}`,
    `freezes ${f(sample.freezes)} (${f(sample.freezeMs, " ms")})  dropped ${f(sample.framesDropped)}`,
    `jitter buf ${f(sample.jitterBufferMs, " ms", 1)}  lost ${f(sample.packetsLost)}/${f(sample.packetsReceived)}`,
    `rtt ${f(sample.rttMs, " ms")}`,
    `input ${f(sample.inputSends)}/win  buffered ${f(sample.inputBufferedMax, " B")}`,
  ].join("\n");
}
