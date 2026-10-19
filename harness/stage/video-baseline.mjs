// Video smoothness for N guests at once, in a real match: displayed-frame intervals (requestVideoFrameCallback), freezes, drops,
// jitter-buffer delay, decode time, loss, per guest. Needs only the guest links, so it runs from any box with playwright.
// usage: node harness/stage/video-baseline.mjs <out.json> <seconds> [--match] <guest link> [<guest link> ...]
//   --unpause the first guest is P1 and taps Start once (resumes a match P1 left paused).
//   --match   the first guest clicks "Play vs CPU" (3 CPUs) before the window starts and "Back to menu" after it.
// Pair it with `node ~/lab/hostsamp.mjs <seconds>` on the VM (host-side encoder stats and VM CPU) for the sender view.
import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";

const argv = process.argv.slice(2);
const match = argv.includes("--match");
const unpause = argv.includes("--unpause");
const [outPath, secs, ...links] = argv.filter((a) => !a.startsWith("--"));
const S = Number(secs);
const browser = await chromium.launch({ args: ["--mute-audio"] });
const pages = [];
for (const link of links) {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.goto(link);
  pages.push(page);
}
await Promise.all(pages.map((p) => p.waitForFunction(() => document.querySelector("video")?.videoWidth > 0 && document.querySelector("video").currentTime > 1, null, { timeout: 120000 })));
await pages[0].waitForTimeout(3000);
if (unpause) {   // the first guest is P1 and taps Start: a match left paused by P1 only resumes from P1
  await pages[0].evaluate(async () => { window.__smashGuest.setVirtualInput({ buttons: 0x1000, sx: 0, sy: 0 }); await new Promise((r) => setTimeout(r, 120)); window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }); });
  await pages[0].waitForTimeout(4000);
}
if (match) {
  await pages[0].selectOption("#solo-cpus", "3");
  await pages[0].click("#solo");
  await pages[0].waitForTimeout(9000);   // character select to stage to the fight
}
const results = await Promise.all(pages.map((page) => page.evaluate(async (S) => {
  const v = document.querySelector("video"); const iv = []; let last = null; let on = true;
  v.requestVideoFrameCallback(function cb(now) { if (last != null) iv.push(now - last); last = now; if (on) v.requestVideoFrameCallback(cb); });
  const rtc = async () => { const all = (await window.__smashGuest.stats()).rtcStats; return { v: all.find((r) => r.type === "inbound-rtp" && r.kind === "video"), pair: all.find((r) => r.type === "candidate-pair" && r.nominated) }; };
  const a = await rtc();
  await new Promise((r) => setTimeout(r, S * 1000)); on = false;
  const b = await rtc(); const s0 = a.v, s1 = b.v;
  iv.sort((x, y) => x - y); const q = (p) => iv[Math.min(iv.length - 1, Math.floor(iv.length * p))];
  const d = (k) => (s1[k] ?? 0) - (s0[k] ?? 0); const frames = d("framesDecoded");
  return { seconds: S, displayedFps: +(iv.length / S).toFixed(1), decodedFps: +(frames / S).toFixed(1), intervalMs: { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +iv[iv.length - 1].toFixed(1) },
    over25ms: iv.filter((x) => x > 25).length, over40ms: iv.filter((x) => x > 40).length, over100ms: iv.filter((x) => x > 100).length,
    freezes: d("freezeCount"), freezeSec: +d("totalFreezesDuration").toFixed(2), framesDropped: d("framesDropped"), packetsLost: d("packetsLost"), nack: d("nackCount"), pli: d("pliCount"), keyFrames: d("keyFramesDecoded"),
    jitterBufferMsPerFrame: +((1000 * d("jitterBufferDelay")) / d("jitterBufferEmittedCount")).toFixed(1), jitterBufferTargetMs: +((1000 * d("jitterBufferTargetDelay")) / d("jitterBufferEmittedCount")).toFixed(1),
    decodeMsPerFrame: +((1000 * d("totalDecodeTime")) / frames).toFixed(2), interFrameStdMs: +(Math.sqrt(Math.max(0, d("totalSquaredInterFrameDelay") / frames - (d("totalInterFrameDelay") / frames) ** 2)) * 1000).toFixed(2),
    mbps: +((d("bytesReceived") * 8) / S / 1e6).toFixed(2), rttMs: b.pair ? +(b.pair.currentRoundTripTime * 1000).toFixed(1) : null, size: `${s1.frameWidth}x${s1.frameHeight}`, decoder: s1.decoderImplementation };
}, S)));
if (match) { await pages[0].click("#back-to-menu"); await pages[0].click("#end-yes"); await pages[0].waitForTimeout(1500); }
fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
for (const r of results) console.log(JSON.stringify(r));
await browser.close();
