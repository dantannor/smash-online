// Run on the VM: samples the host page outbound video stats (encode time, fps, bitrate, qualityLimitationReason, keyframes) and VM CPU once a second.
// usage (on the VM, with the repo at ~/smash-online): node harness/stage/host-sampler.mjs <seconds> > host.jsonl
import WebSocket from "ws";
import fs from "node:fs";
const secs = Number(process.argv[2] || 30);
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find(t => t.type === "page" && /\/host/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(r => ws.once("open", r));
let id = 0; const pend = new Map();
ws.on("message", d => { const m = JSON.parse(d); pend.get(m.id)?.(m); });
const ev = expr => new Promise(res => { const i = ++id; pend.set(i, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
const EXPR = `(async()=>{const o=[];
 const st=window.__smashHostStats(); const out={};
 return JSON.stringify(st.rtcStats.filter(r=>r.type==='outbound-rtp'&&r.kind==='video').map(r=>({port:r.port,t:r.timestamp,fe:r.framesEncoded,fs:r.framesSent,bs:r.bytesSent,tet:r.totalEncodeTime,tpsd:r.totalPacketSendDelay,kf:r.keyFramesEncoded,fps:r.framesPerSecond,w:r.frameWidth,h:r.frameHeight,q:r.qualityLimitationReason,qd:r.qualityLimitationDurations,pli:r.pliCount,nack:r.nackCount,rtx:r.retransmittedPacketsSent,tb:r.targetBitrate,hsf:r.huge_frames_sent,enc:r.encoderImplementation,fch:r.qualityLimitationResolutionChanges})))})()`;
const readCpu = () => { const l = fs.readFileSync("/proc/stat","utf8").split("\n")[0].split(/\s+/).slice(1).map(Number); return [l.reduce((a,b)=>a+b,0), l[3]+l[4]]; };
let c0 = readCpu();
for (let i = 0; i < secs; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const c1 = readCpu(); const cpu = 100 * (1 - (c1[1]-c0[1])/(c1[0]-c0[0])); c0 = c1;
  console.log(JSON.stringify({ wall: Date.now(), cpu: +cpu.toFixed(1), peers: JSON.parse(await ev(EXPR)) }));
}
process.exit(0);
