import { chromium } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMockRuntime } from "./mocks/runtime.js";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const seconds = Number(option("--seconds", "10"));
const label = option("--label", new Date().toISOString().replaceAll(/[:.]/g, "-"));
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("--seconds must be between 0 and 3600");
if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error("--label may contain only letters, numbers, underscore, and dash");
let runtime;
let context;
let profileDir;
const suppliedUrl = option("--url", null);
const mode = option("--mode", suppliedUrl ? "real" : "mock");
if (!new Set(["mock", "local", "tunnel", "real"]).has(mode)) throw new Error("--mode must be mock, local, tunnel, or real");
if (!suppliedUrl) runtime = await startMockRuntime();
const base = (suppliedUrl ?? runtime.origin).replace(/\/$/, "");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const median = (values) => values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
try {
  const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!roomResponse.ok) throw new Error(`room create failed: HTTP ${roomResponse.status}`);
  const room = await roomResponse.json();
  const hostUrl = new URL(room.hostUrl);
  hostUrl.searchParams.set("source", "canvas");
  profileDir = await mkdtemp(path.join(tmpdir(), "smash-latency-chrome-"));
  context = await chromium.launchPersistentContext(profileDir, { headless: true });
  if (room.roomToken) await context.addInitScript(({ roomName, token }) => {
    sessionStorage.setItem(`smash-room-token:${roomName}`, token);
    sessionStorage.setItem("smash-room-token", token);
  }, { roomName: room.room, token: room.roomToken });
  const host = await context.newPage();
  if (room.roomToken) await context.addInitScript(({ roomName, token }) => { window.__SMASH_E2E_ROOM__ = { room: roomName, roomToken: token }; }, { roomName: room.room, token: room.roomToken });
  await host.goto(hostUrl.toString());
  await host.waitForFunction(() => typeof window.__smashHostStats === "function", null, { timeout: 15000 });
  const guest = await context.newPage();
  await guest.goto(room.slots[0].guestUrl);
  await guest.waitForFunction(() => typeof window.__smashGuest?.stats === "function", null, { timeout: 15000 });
  await guest.waitForFunction(() => window.__smashGuest.state?.connected === true, null, { timeout: 15000 });
  await guest.waitForFunction(() => {
    const video = document.querySelector("video");
    return video?.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0;
  }, null, { timeout: 15000 });
  const started = Date.now();
  const measurements = { rttMs: [], jitterBufferMs: [], framesPerSecond: [], framesDropped: [], framesDecoded: [], glassToGlassMs: [] };
  while (Date.now() - started < seconds * 1000) {
    const guestStats = await guest.evaluate(async () => await window.__smashGuest.stats());
    const hostStats = await host.evaluate(async () => await window.__smashHostStats());
    const stats = [...(guestStats.rtcStats ?? []), ...(hostStats.rtcStats ?? [])];
    const pair = stats.find((entry) => entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated && Number.isFinite(entry.currentRoundTripTime));
    if (pair) measurements.rttMs.push(pair.currentRoundTripTime * 1000);
    const inbound = stats.filter((entry) => entry.type === "inbound-rtp" && entry.kind === "video");
    for (const entry of inbound) {
      if (entry.jitterBufferEmittedCount > 0 && Number.isFinite(entry.jitterBufferDelay)) measurements.jitterBufferMs.push(entry.jitterBufferDelay / entry.jitterBufferEmittedCount * 1000);
      if (Number.isFinite(entry.framesPerSecond)) measurements.framesPerSecond.push(entry.framesPerSecond);
      if (Number.isFinite(entry.framesDropped)) measurements.framesDropped.push(entry.framesDropped);
      if (Number.isFinite(entry.framesDecoded)) measurements.framesDecoded.push(entry.framesDecoded);
    }
    const glass = await guest.evaluate(() => {
      const video = document.querySelector("video");
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      const sourceScaleX = video.videoWidth / 1280;
      const sourceScaleY = video.videoHeight / 720;
      const barcodeWidth = Math.ceil(96 * 4 * sourceScaleX);
      const barcodeHeight = Math.max(1, Math.ceil(12 * sourceScaleY));
      const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = barcodeHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, video.videoWidth, video.videoHeight);
      const pixels = ctx.getImageData(0, 0, barcodeWidth, barcodeHeight);
      const bytes = new Uint8Array(12);
      const sampleY = Math.min(barcodeHeight - 1, Math.floor(6 * sourceScaleY));
      for (let bit = 0; bit < 96; bit++) {
        const sampleX = Math.min(barcodeWidth - 1, Math.floor((bit + 0.5) * 4 * sourceScaleX));
        const offset = (sampleY * pixels.width + sampleX) * 4;
        bytes[bit >> 3] |= (pixels.data[offset] > 127 ? 1 : 0) << (7 - (bit & 7));
      }
      const view = new DataView(bytes.buffer);
      const capturedAt = view.getFloat64(4);
      if (!Number.isFinite(capturedAt) || capturedAt < 1e12) return null;
      return { frame: view.getUint32(0), latency: performance.timeOrigin + performance.now() - capturedAt };
    });
    if (glass) measurements.glassToGlassMs.push(glass.latency);
    await delay(250);
  }
  const finalStats = await guest.evaluate(async () => await window.__smashGuest.stats());
  const summarized = {
    mode,
    url: base,
    label,
    seconds,
    collectedAt: new Date().toISOString(),
    rttMs: { mean: mean(measurements.rttMs), samples: measurements.rttMs.length },
    jitterBufferMs: { mean: mean(measurements.jitterBufferMs), samples: measurements.jitterBufferMs.length },
    framesPerSecond: { mean: mean(measurements.framesPerSecond), samples: measurements.framesPerSecond.length },
    framesDropped: { last: measurements.framesDropped.at(-1) ?? null },
    framesDecoded: { last: measurements.framesDecoded.at(-1) ?? null },
    glassToGlassMs: { mean: mean(measurements.glassToGlassMs), median: median(measurements.glassToGlassMs), samples: measurements.glassToGlassMs.length },
    peerStatsAvailable: Array.isArray(finalStats.rtcStats),
    guestVideo: await guest.evaluate(() => { const video = document.querySelector("video"); return { received: video?.videoWidth > 0 && video.currentTime > 0, width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0 }; }),
  };
  const reports = path.join(root, "harness/reports");
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(reports, `latency-${label}.json`), `${JSON.stringify(summarized, null, 2)}\n`);
  console.log(JSON.stringify(summarized, null, 2));
} finally {
  await context?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await runtime?.close();
}
