// Stage-by-stage input-to-photon latency against the live cloud VM (see harness/stage/README.md).
// usage: node harness/stage/stage-latency.mjs <guest link> <trials> <out.json>
// Needs: SSH to the VM (scripts/cloud.sh set up the ssh config), playwright. Nothing is changed on the VM except a probe binary
// in ~/lab and a temporary monkeypatch of the host page (through CDP, lost on the next page reload).
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "../../node_modules/ws/wrapper.mjs";

const [link, trials = "60", outPath = "/tmp/smash-gcp/lab/stage.json"] = process.argv.slice(2);
const CONF = process.env.SMASH_CLOUD_DIR || `${os.homedir()}/.smash-online`;
const SSH = ["-F", `${CONF}/ssh_config`, "smash-vm"];
const ssh = (cmd) => execFileSync("ssh", [...SSH, cmd], { encoding: "utf8", maxBuffer: 64 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIGHT = process.env.LIGHT === "1"; // end-to-end total only: nothing is hooked on the VM, so the numbers carry no instrumentation load

// --- CDP into the VM's host page through an SSH tunnel ---
let tunnel, cdp, hostEval;
if (!LIGHT) {
tunnel = spawn("ssh", [...SSH.slice(0, 2), "-N", "-L", "9223:127.0.0.1:9222", SSH[2]], { stdio: "ignore" });
await sleep(3000);
const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const hostPage = targets.find((t) => t.type === "page" && /\/host/.test(t.url));
cdp = new WebSocket(hostPage.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => cdp.once("open", r));
let cdpId = 0; const pending = new Map();
cdp.on("message", (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
hostEval = (expression) => new Promise((resolve, reject) => {
  const id = ++cdpId; pending.set(id, (m) => { pending.delete(id); m.error || m.result?.exceptionDetails ? reject(new Error(JSON.stringify(m.error || m.result.exceptionDetails))) : resolve(m.result.result.value); });
  cdp.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
});

const HOST_HOOK = `(async () => {
  const wall = () => performance.timeOrigin + performance.now();
  if (window.__lat3) { window.__lat3.rx.length = 0; window.__lat3.cap.length = 0; window.__lat3.snd.length = 0; window.__lat3.enc.length = 0; return 'reset'; }
  const L = window.__lat3 = { rx: [], cap: [], pcs: [], capFrames: 0, snd: [], enc: [] };
  const orig = RTCPeerConnection.prototype.createDataChannel; L.restore = [];
  L.restore.push(() => { RTCPeerConnection.prototype.createDataChannel = orig; });
  RTCPeerConnection.prototype.createDataChannel = function (label, o) {
    const ch = orig.call(this, label, o);
    if (!L.pcs.includes(this)) L.pcs.push(this);
    if (label === 'input') ch.addEventListener('message', e => { const h = wall(); try { const m = JSON.parse(e.data); L.rx.push([h, m.seq, m.t, m.buttons]); if (L.rx.length > 30000) L.rx.shift(); } catch {} });
    if (label === 'meta') ch.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (m.type === 'clk') ch.send(JSON.stringify({ type: 'pong', c: m.c, h: wall() })); } catch {} });
    return ch;
  };
  // encoded-frame tap: timestamps each frame as it leaves the encoder (before packetization), for the stage breakdown
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...r) { return new OrigPC({ ...(cfg || {}), encodedInsertableStreams: true }, ...r); };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  L.restore.push(() => { window.RTCPeerConnection = OrigPC; });
  const origAdd = OrigPC.prototype.addTransceiver;
  L.restore.push(() => { OrigPC.prototype.addTransceiver = origAdd; });
  OrigPC.prototype.addTransceiver = function (...a) {
    const t = origAdd.apply(this, a);
    try { const isVideo = a[0] === 'video' || a[0]?.kind === 'video';
      if (isVideo && t.sender) { const { readable, writable } = t.sender.createEncodedStreams();
        readable.pipeThrough(new TransformStream({ transform(frame, ctl) { L.enc.push([wall(), frame.data.byteLength, frame.type, frame.timestamp]); if (L.enc.length > 40000) L.enc.shift(); ctl.enqueue(frame); } })).pipeTo(writable); } } catch (e) { L.encErr = String(e); }
    return t;
  };
  const track = document.querySelector('#preview').srcObject.getVideoTracks()[0];
  L.restore.push(() => { try { reader.cancel(); } catch {} });
  const proc = new MediaStreamTrackProcessor({ track }); const reader = proc.readable.getReader();
  const cv = new OffscreenCanvas(64, 48), g = cv.getContext('2d', { willReadFrequently: true });
  let prev = null;
  (async () => { for (;;) { const { value: f, done } = await reader.read(); if (done) break; const h = wall(); g.drawImage(f, 0, 0, 64, 48); f.close();
    const d = g.getImageData(0, 0, 64, 48).data; L.capFrames++;
    if (prev) { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]); const sc = s / (d.length / 4) / 3; if (sc > 0.3) { L.cap.push([h, +sc.toFixed(2)]); if (L.cap.length > 30000) L.cap.shift(); } }
    prev = d; } })();
  L.timer = setInterval(async () => { const pc = L.pcs.find(p => p.connectionState === 'connected'); if (!pc) return; const sender = pc.getSenders().find(s => s.track?.kind === 'video'); if (!sender) return;
    const r = [...(await sender.getStats()).values()].find(x => x.type === 'outbound-rtp'); if (!r) return;
    L.snd.push([wall(), r.framesEncoded, r.bytesSent, r.totalEncodeTime, r.totalPacketSendDelay, r.packetsSent, r.keyFramesEncoded, r.targetBitrate, r.framesSent]); if (L.snd.length > 40000) L.snd.shift(); }, 10);
  return 'hooked';
})()`;
console.error("hook:", await hostEval(HOST_HOOK));

// --- VM-side probe ---
ssh("pkill vm-probe; true");
const probeSecs = Math.ceil(Number(trials) * 2.6 + 40);
ssh(`cd ~/lab && rm -f probe.log && (DISPLAY=:99 nohup ./vm-probe /home/smash/.smash-online/input.osi1 ${probeSecs} > probe.log 2>/dev/null &) ; sleep 0.5; echo ok`);
}
// --- guest ---
const browser = await chromium.launch({ args: ["--mute-audio"] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
await page.addInitScript(() => {
  const Orig = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); pc.addEventListener('datachannel', e => { if (e.channel.label === 'meta') { window.__meta = e.channel; window.__pongs = []; e.channel.addEventListener('message', ev => { try { const m = JSON.parse(ev.data); if (m.type === 'pong') window.__pongs.push([m.c, m.h, performance.timeOrigin + performance.now()]); } catch {} }); } }); return pc; };
  window.RTCPeerConnection.prototype = Orig.prototype;
});
await page.goto(link);
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0 && document.querySelector("video").currentTime > 1 && window.__meta?.readyState === "open", null, { timeout: 120000 });
await sleep(2000);
const guest = await page.evaluate(async ([N, LIGHT_]) => {
  const wall = () => performance.timeOrigin + performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const v = document.querySelector("video"); const c = document.createElement("canvas"); c.width = 64; c.height = 48; const g = c.getContext("2d", { willReadFrequently: true });
  const frames = []; let prev = null;
  v.requestVideoFrameCallback(function cb(now, m) {
    g.drawImage(v, 0, 0, 64, 48); const d = g.getImageData(0, 0, 64, 48).data; let sc = 0;
    if (prev) { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]); sc = s / (d.length / 4) / 3; }
    prev = d; const o = performance.timeOrigin;
    frames.push([o + now, +sc.toFixed(2), m.receiveTime != null ? o + m.receiveTime : null, m.expectedDisplayTime != null ? o + m.expectedDisplayTime : null, m.processingDuration ?? null, m.presentedFrames, m.rtpTimestamp ?? null, m.captureTime != null ? o + m.captureTime : null, wall()]);
    v.requestVideoFrameCallback(cb);
  });
  for (let i = 0; i < (LIGHT_ ? 0 : 40); i++) { window.__meta.send(JSON.stringify({ type: "clk", c: wall() })); await sleep(40); }
  const trialsOut = [];
  const inputSend = window.__smashGuest.setVirtualInput;
  for (let t = 0; t < N; t++) {
    window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }); await sleep(1300);
    const t0 = wall(); const bt = t % 2 ? 0x10 : 0x20;
    window.__smashGuest.setVirtualInput({ buttons: bt, sx: 0, sy: 0 });
    const t1 = wall();
    await sleep(700);
    trialsOut.push([t0, t1, bt]);
    window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }); await sleep(300);
  }
  const rtc = [...(await window.__smashGuest.stats()).rtcStats];
  return { trials: trialsOut, frames, pongs: window.__pongs, rtc };
}, [Number(trials), LIGHT]);

// --- collect ---
const hostData = LIGHT ? null : JSON.parse(await hostEval(`(async () => { const L = window.__lat3; const out = []; for (const pc of L.pcs) { if (pc.connectionState !== 'connected') continue; out.push([...(await pc.getStats()).values()]); } return JSON.stringify({ rx: L.rx, cap: L.cap, capFrames: L.capFrames, snd: L.snd, enc: L.enc, encErr: L.encErr, stats: out }); })()`));
if (!LIGHT) await hostEval(`(() => { const L = window.__lat3; L.restore.forEach((f) => f()); clearInterval(L.timer); delete window.__lat3; return 'unhooked'; })()`);   // leaves the host page as found (the patches would otherwise break audio for the next guest)
await sleep(2000);
const probe = LIGHT ? "" : ssh("cat ~/lab/probe.log");
fs.writeFileSync(outPath, JSON.stringify({ guest, hostData, probe }));
console.error("saved", outPath, "frames", guest.frames.length);
await browser.close(); cdp?.close(); tunnel?.kill();
