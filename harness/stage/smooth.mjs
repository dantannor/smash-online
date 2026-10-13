// Playback smoothness of one guest over a time window: displayed-frame intervals (requestVideoFrameCallback), freezes, loss, fps.
// usage: node harness/stage/smooth.mjs <guest link> [seconds=40]   (pair it with a netem profile on the VM to compare configs)
import { chromium } from "../../node_modules/playwright/index.mjs";
const [link, secs = "40"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--mute-audio"] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
await page.goto(link);
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0 && document.querySelector("video").currentTime > 1, null, { timeout: 120000 });
await page.waitForTimeout(2000);
const out = await page.evaluate(async (S) => {
  const v = document.querySelector("video"); const iv = []; let last = null; let on = true;
  v.requestVideoFrameCallback(function cb(now) { if (last != null) iv.push(now - last); last = now; if (on) v.requestVideoFrameCallback(cb); });
  const s0 = (await window.__smashGuest.stats()).rtcStats.find((r) => r.type === "inbound-rtp" && r.kind === "video");
  await new Promise((r) => setTimeout(r, S * 1000)); on = false;
  const all = (await window.__smashGuest.stats()).rtcStats; const s1 = all.find((r) => r.type === "inbound-rtp" && r.kind === "video");
  iv.sort((a, b) => a - b); const q = (p) => iv[Math.min(iv.length - 1, Math.floor(iv.length * p))];
  const pair = all.find((r) => r.type === "candidate-pair" && r.nominated);
  return { seconds: S, displayedFrames: iv.length, fps: +(iv.length / S).toFixed(1), intervalMsP50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +iv[iv.length - 1].toFixed(1),
    over25ms: iv.filter((x) => x > 25).length, over40ms: iv.filter((x) => x > 40).length,
    freezes: s1.freezeCount - (s0.freezeCount || 0), freezeSec: +(s1.totalFreezesDuration - (s0.totalFreezesDuration || 0)).toFixed(2), packetsLost: s1.packetsLost - s0.packetsLost, framesDropped: s1.framesDropped - s0.framesDropped,
    nack: s1.nackCount - s0.nackCount, pli: s1.pliCount - s0.pliCount, rttMs: pair ? +(pair.currentRoundTripTime * 1000).toFixed(1) : null,
    jitterBufferMsPerFrame: +((1000 * (s1.jitterBufferDelay - s0.jitterBufferDelay)) / (s1.jitterBufferEmittedCount - s0.jitterBufferEmittedCount)).toFixed(1), mbps: +(((s1.bytesReceived - s0.bytesReceived) * 8) / S / 1e6).toFixed(2) };
}, Number(secs));
console.log(JSON.stringify(out));
await browser.close();
