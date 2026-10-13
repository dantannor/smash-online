// Join the guest / host-page / VM-probe timelines of one stage-latency run into per-stage numbers.
// usage: node harness/stage/analyze.mjs <run.json> [flipThreshold=6]
import fs from "node:fs";
const [file, thr = "6"] = process.argv.slice(2);
const T = Number(thr);
const { guest, hostData, probe } = JSON.parse(fs.readFileSync(file, "utf8"));
const pct = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
// clock offset guest -> host (VM): best-RTT pongs
if (!hostData) { // LIGHT run: end-to-end only
  const tot = guest.trials.map(([t0]) => { const f = guest.frames.find((x) => x[0] >= t0 && x[1] > T); return f ? f[0] - t0 : null; });
  const ok = tot.filter(Number.isFinite);
  const gi = guest.rtc.find((r) => r.type === "inbound-rtp" && r.kind === "video"), pair = guest.rtc.find((r) => r.type === "candidate-pair" && r.nominated);
  console.log(JSON.stringify({ mode: "light", n: ok.length, medianMs: +pct(tot, 0.5).toFixed(1), p90Ms: +pct(tot, 0.9).toFixed(1), minMs: +pct(tot, 0).toFixed(1), maxMs: +pct(tot, 0.999).toFixed(1), rttMs: pair ? +(pair.currentRoundTripTime * 1000).toFixed(1) : null, fps: gi.framesPerSecond }));
  process.exit(0);
}
const pongs = (guest.pongs || []).map(([c0, h, c1]) => ({ rtt: c1 - c0, off: h - (c0 + (c1 - c0) / 2) })).sort((a, b) => a.rtt - b.rtt).slice(0, 8);
const off = pongs.reduce((s, p) => s + p.off, 0) / pongs.length;
const dcRtt = pongs[0].rtt;
const F = probe.split("\n").filter((l) => l[0] === "F").map((l) => l.split(" ")).map(([, t, p, b]) => [+t, +p, +b]);
const X = probe.split("\n").filter((l) => l[0] === "X").map((l) => l.split(" ")).map(([, t, s]) => [+t, +s]);
const rx = hostData.rx, cap = hostData.cap;
const rows = [];
for (const [t0, t1, bt] of guest.trials) {
  const h0 = t0 + off; // trial start on the VM clock
  const hostRx = rx.find((r) => r[0] >= h0 - 5 && (r[3] & bt));
  const file = hostRx && F.find((f) => f[0] >= hostRx[0] - 2 && f[2] & bt);
  const xch = file && X.find((x) => x[0] >= file[0] - 2 && x[1] > T);
  const cp = xch && cap.find((c) => c[0] >= xch[0] - 2 && c[1] > T);
  const gf = guest.frames.find((f) => f[0] + 0 >= t0 && f[1] > T);
  if (!(hostRx && file && xch && cp && gf)) { rows.push(null); continue; }
  const gRecv = gf[2] != null ? gf[2] + off : null, gPres = gf[0] + off;
  rows.push({
    send: t1 - t0,
    net_up: hostRx[0] - (t1 + off),
    host_to_file: file[0] - hostRx[0],
    game: xch[0] - file[0],
    capture: cp[0] - xch[0],
    cap_to_recv: gRecv != null ? gRecv - cp[0] : null,
    recv_to_present: gRecv != null ? gPres - gRecv : null,
    total: gf[0] - t0,
    present_cb_minus_expected: gf[3] != null ? gf[0] - gf[3] : null,
    proc: gf[4] != null ? gf[4] * 1000 : null,
  });
}
const ok = rows.filter(Boolean);
console.log(JSON.stringify({ trials: guest.trials.length, joined: ok.length, clockOffsetMs: +off.toFixed(1), dcRttMs: +dcRtt.toFixed(1) }));
const keys = Object.keys(ok[0] || {});
console.log("stage".padEnd(28), "median".padStart(8), "p90".padStart(8), "min".padStart(8), "max".padStart(8));
for (const k of keys) { const v = ok.map((r) => r[k]); console.log(k.padEnd(28), ...[pct(v, 0.5), pct(v, 0.9), pct(v, 0), pct(v, 0.999)].map((x) => (x == null ? "-" : x.toFixed(1)).padStart(8))); }
// stats summary
const gi = guest.rtc.find((r) => r.type === "inbound-rtp" && r.kind === "video");
const per = (n, d, k = 1000) => (d ? +((k * n) / d).toFixed(2) : null);
console.log("guest inbound:", JSON.stringify({ fps: gi.framesPerSecond, w: gi.frameWidth, h: gi.frameHeight, jitterBufferMsPerFrame: per(gi.jitterBufferDelay, gi.jitterBufferEmittedCount), jitterTargetMs: per(gi.jitterBufferTargetDelay, gi.jitterBufferEmittedCount), decodeMs: per(gi.totalDecodeTime, gi.framesDecoded), processingMs: per(gi.totalProcessingDelay, gi.framesDecoded), assemblyMs: per(gi.totalAssemblyTime, gi.framesAssembledFromMultiplePackets || 1), decoder: gi.decoderImplementation, dropped: gi.framesDropped, nack: gi.nackCount, pli: gi.pliCount }));
for (const st of hostData.stats) { const o = st.find((r) => r.type === "outbound-rtp" && r.kind === "video"); if (o) console.log("host outbound:", JSON.stringify({ fps: o.framesPerSecond, w: o.frameWidth, h: o.frameHeight, encodeMsPerFrame: per(o.totalEncodeTime, o.framesEncoded), packetSendDelayMsPerPkt: per(o.totalPacketSendDelay, o.packetsSent), encoder: o.encoderImplementation, limit: o.qualityLimitationReason, keyFrames: o.keyFramesEncoded, bytes: o.bytesSent })); }
