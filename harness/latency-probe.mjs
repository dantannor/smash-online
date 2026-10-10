import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
const suppliedUrl = option("--url", null);
if (!suppliedUrl) runtime = await startMockRuntime();
const base = (suppliedUrl ?? runtime.origin).replace(/\/$/, "");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let browser;

const median = (values) => values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
try {
  const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!roomResponse.ok) throw new Error(`room create failed: HTTP ${roomResponse.status}`);
  const room = await roomResponse.json();
  const hostUrl = new URL(room.hostUrl);
  hostUrl.searchParams.set("source", "canvas");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
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
      const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = 16;
      const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(video, 0, 0, canvas.width, 16, 0, 0, canvas.width, 16);
      const pixels = ctx.getImageData(0, 0, 96, 12);
      const bytes = new Uint8Array(12);
      for (let bit = 0; bit < 96; bit++) { const offset = (6 * pixels.width + bit) * 4; bytes[bit >> 3] |= (pixels.data[offset] > 127 ? 1 : 0) << (7 - (bit & 7)); }
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
    mode: suppliedUrl ? "url" : "mock",
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
  };
  const reports = path.join(root, "harness/reports");
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(reports, `latency-${label}.json`), `${JSON.stringify(summarized, null, 2)}\n`);
  const markdown = `# Latency probe: ${label}\n\n- Target: ${base}\n- Mode: ${summarized.mode}\n- Duration: ${seconds}s\n- RTT: ${summarized.rttMs.mean?.toFixed(2) ?? "n/a"} ms (${summarized.rttMs.samples} samples)\n- Average jitter buffer: ${summarized.jitterBufferMs.mean?.toFixed(2) ?? "n/a"} ms (${summarized.jitterBufferMs.samples} samples)\n- Frames per second: ${summarized.framesPerSecond.mean?.toFixed(2) ?? "n/a"}\n- Frames dropped / decoded: ${summarized.framesDropped.last ?? "n/a"} / ${summarized.framesDecoded.last ?? "n/a"}\n- Glass-to-glass: ${summarized.glassToGlassMs.mean?.toFixed(2) ?? "n/a"} ms mean, ${summarized.glassToGlassMs.median?.toFixed(2) ?? "n/a"} ms median (${summarized.glassToGlassMs.samples} samples)\n`;
  await writeFile(path.join(root, "harness/LATENCY.md"), markdown);
  console.log(JSON.stringify(summarized, null, 2));
} finally {
  await browser?.close();
  await runtime?.close();
}
