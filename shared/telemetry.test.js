import test from "node:test";
import assert from "node:assert/strict";
import { snapshotStats, diffSample, sanitizeSample, telemetryLine, overlayText } from "./telemetry.js";

const report = items => ({ forEach: fn => items.forEach(fn) });
const video = over => ({ type: "inbound-rtp", kind: "video", framesDecoded: 0, framesDropped: 0, freezeCount: 0, totalFreezesDuration: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, packetsLost: 0, packetsReceived: 0, totalInterFrameDelay: 0, totalSquaredInterFrameDelay: 0, ...over });
const pair = { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.058 };

test("diffSample turns counter deltas into rates", () => {
  const a = snapshotStats(report([pair, video({})]), { sends: 10, buffered: 0 }, 1000);
  const b = snapshotStats(report([pair, video({ framesDecoded: 300, framesDropped: 2, freezeCount: 1, totalFreezesDuration: 0.25, jitterBufferDelay: 3, jitterBufferEmittedCount: 300, packetsLost: 4, packetsReceived: 900, totalInterFrameDelay: 5, totalSquaredInterFrameDelay: 5 * (5 / 300) + 0.0001 * 300 })]), { sends: 70, buffered: 12 }, 6000);
  const s = diffSample(a, b, 48);
  assert.equal(s.windowMs, 5000);
  assert.equal(s.fps, 60);
  assert.equal(s.freezes, 1);
  assert.equal(s.freezeMs, 250);
  assert.equal(s.framesDropped, 2);
  assert.equal(s.jitterBufferMs, 10);
  assert.equal(s.packetsLost, 4);
  assert.equal(s.rttMs, 58);
  assert.equal(s.inputSends, 60);
  assert.equal(s.inputBufferedMax, 48);
  assert.ok(s.frameJitterMs > 0 && s.frameJitterMs < 100);
});

test("diffSample is null without video or a window, and never goes negative after a counter reset", () => {
  const none = snapshotStats(report([pair]), {}, 1000);
  const v = snapshotStats(report([video({ framesDecoded: 100, packetsLost: 9 })]), {}, 2000);
  assert.equal(diffSample(none, v), null);
  assert.equal(diffSample(null, v), null);
  assert.equal(diffSample(v, { ...v }), null);
  const reset = snapshotStats(report([video({ framesDecoded: 5 })]), {}, 3000);
  const s = diffSample(v, reset);
  assert.equal(s.packetsLost, 0);
  assert.equal(s.fps, 0);
});

test("sanitizeSample keeps only known finite numbers", () => {
  const s = sanitizeSample({ fps: 59.987, rttMs: null, evil: "x", ip: "1.2.3.4", freezes: "7", framesDropped: Infinity, inputSends: 3 });
  assert.deepEqual(s, { fps: 59.99, rttMs: null, inputSends: 3 });
  assert.equal(sanitizeSample({ evil: 1 }), null);
  assert.equal(sanitizeSample([1]), null);
  assert.equal(sanitizeSample(null), null);
});

test("telemetryLine carries port and time only, one line", () => {
  const line = telemetryLine(2, { fps: 60 }, Date.UTC(2026, 9, 19));
  assert.equal(line, '{"at":"2026-10-19T00:00:00.000Z","port":2,"fps":60}\n');
});

test("overlayText renders missing values as dashes", () => {
  assert.match(overlayText(null), /waiting/);
  assert.match(overlayText({ fps: 60, frameJitterMs: null }), /fps 60  jitter --/);
});
