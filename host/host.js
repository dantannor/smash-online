import { mapGamepad, mapKeyboard } from "/play/input-map.js";
import { clampInputMessage, validateInputMessage } from "../shared/protocol.js";

const STORAGE_KEY = "smash-host-room";
// Optional remote signaling origin (the Cloudflare Worker). The host page itself stays local so it can reach the sidecar.
const signalOrigin = (() => {
  const valid = value => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : ""; } catch { return ""; } };
  const param = new URLSearchParams(location.search).get("signal");
  if (param !== null) return valid(param);
  try { return valid(JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null")?.signal || ""); } catch { return ""; }
})();
const FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const statusEl = document.querySelector("#status");
const linksEl = document.querySelector("#guest-links");
const statsEl = document.querySelector("#stats");
const preview = document.querySelector("#preview");
const startButton = document.querySelector("#start");
const resumeButton = document.querySelector("#resume");
const sourceSelect = document.querySelector("#source");
const peers = new Map();
// Fighter finder (cloud host): guests ask for a character select page over a reliable "meta" data channel; the sidecar passes it to the game.
let rosterList = null;
let lastRosterPage = 1;
async function loadRoster() {
  rosterList ??= fetch("/roster.json", { cache: "no-store" }).then(r => r.json()).catch(() => ({ originals: [], custom: [] }));
  return rosterList;
}
async function sendRoster(channel) {
  const { originals, custom } = await loadRoster();
  const send = value => { if (channel.readyState === "open") channel.send(JSON.stringify(value)); };
  send({ type: "roster:begin", originals, total: custom.length, pages: 1 + Math.ceil(custom.length / 12), page: lastRosterPage });
  for (let i = 0; i < custom.length; i += 60) send({ type: "roster:chunk", offset: i, items: custom.slice(i, i + 60).map(c => [c.name, c.base, c.portrait || ""]) });
  send({ type: "roster:end" });
}
function handleMeta(port, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message?.type === "roster:pick" && Number.isInteger(message.idx) && message.idx >= -12 && message.idx < 4096) {
    sendSidecar({ type: "roster:pick", port, idx: message.idx });
    return;
  }
  if (message?.type === "roster:solo" && Number.isInteger(message.cpus) && message.cpus >= 1 && message.cpus <= 3) {
    sendSidecar({ type: "roster:solo", port, cpus: message.cpus });
    return;
  }
  if (message?.type === "telemetry") { const peer = peers.get(port); if (peer) sendSidecar({ type: "telemetry", port, connectionId: peer.connectionId, sample: message }); return; }
  if (message?.type === "match:end") { sendSidecar({ type: "match:end", port }); return; }
  if (message?.type === "roster:page" && Number.isInteger(message.page) && message.page >= 0 && message.page < 4096) {
    lastRosterPage = message.page;
    sendSidecar({ type: "roster:page", page: message.page });
    for (const peer of peers.values()) if (peer.meta?.readyState === "open") peer.meta.send(JSON.stringify({ type: "roster:page", page: message.page, by: port }));
  }
}
const creatingPeers = new Map();
// ?p1guest=1 (headless/cloud host): P1 is a guest link like P2-P4 and "Play P1 here" starts off.
const p1Guest = new URLSearchParams(location.search).get("p1guest") === "1";
// Optional cloud-host tuning (query string): audio=1 adds the game's audio (PulseAudio monitor via getUserMedia) to every guest,
// maxkbps caps the video sender, startkbps/minkbps seed the congestion controller so it does not ramp up from a low bitrate.
const tuning = (() => { const q = new URLSearchParams(location.search); const n = name => Number(q.get(name)) || 0; return { audio: q.get("audio") === "1", maxKbps: n("maxkbps") || 6000, startKbps: n("startkbps"), minKbps: n("minkbps") }; })();
let gameAudioPromise = null;
function gameAudio() {
  // Never let the audio device hold up a guest's offer: give up after 4 s (no audio for that guest) and try again for the next one.
  gameAudioPromise ??= Promise.race([
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .catch(error => { status(`Game audio unavailable: ${error.message}`, true); return null; }),
    new Promise(resolve => setTimeout(() => resolve(null), 4000)),
  ]).then(stream => { if (!stream) gameAudioPromise = null; return stream; });
  return gameAudioPromise;
}
function tuneAnswer(sdp) {
  if (!tuning.startKbps) return sdp;
  const bitrates = `x-google-start-bitrate=${tuning.startKbps};x-google-max-bitrate=${tuning.maxKbps}${tuning.minKbps ? `;x-google-min-bitrate=${tuning.minKbps}` : ""}`;
  let inVideo = false;
  return sdp.split("\r\n").map(line => {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    return inVideo && line.startsWith("a=fmtp:") && !line.includes("apt=") ? `${line};${bitrates}` : line;
  }).join("\r\n");
}
const statuses = new Map((p1Guest ? [1, 2, 3, 4] : [2, 3, 4]).map(port => [port, { status: "empty", ping: null }]));
let roomInfo = null;
let stream = null;
let signaling = null;
let sidecar = null;
let sidecarRetry = null;
const sidecarUrl = window.__SMASH_E2E_SIDECAR_URL__ || "ws://127.0.0.1:8765";
let hostConnectionSequence = 0;
let canvasTimer = null;
let gamepadTimer = null;
let lastGamepadState = null;
let canvasFrame = 0;
let canvasTimestamp = null;
const rtcStats = new Map();
const peerRtcStats = new Map();

function status(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", error);
}

function renderLinks(slots) {
  linksEl.replaceChildren();
  for (const slot of slots) {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = `P${slot.port}`;
    const url = document.createElement("input");
    url.className = "link";
    url.readOnly = true;
    url.value = slot.guestUrl;
    url.setAttribute("aria-label", `P${slot.port} guest link`);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url.value); copy.textContent = "Copied"; }
      catch { url.select(); document.execCommand("copy"); copy.textContent = "Copied"; }
      setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
    });
    card.append(title, url, copy);
    linksEl.append(card);
    updateSlotStatus(slot.port, "empty");
  }
}

function updateSlotStatus(port, value, ping) {
  const state = statuses.get(port) || { status: "empty", ping: null };
  state.status = value;
  if (ping !== undefined) state.ping = ping;
  statuses.set(port, state);
  const card = [...statsEl.children].find(item => Number(item.dataset.port) === port);
  const label = card?.querySelector(".slot-status");
  if (label) label.textContent = `${state.status}${state.ping == null ? "" : ` · ${Math.round(state.ping)} ms ping`}`;
}

function ensureStatsCard(port) {
  let card = [...statsEl.children].find(item => Number(item.dataset.port) === port);
  if (!card) {
    card = document.createElement("article");
    card.dataset.port = String(port);
    card.innerHTML = `<h3>P${port}</h3><p class="slot-status">empty</p><dl><dt>Outbound fps / bitrate</dt><dd class="rate">—</dd><dt>Encoded frames / limitation</dt><dd class="encoding">—</dd></dl>`;
    statsEl.append(card);
  }
  return card;
}

async function api(path, options = {}) {
  const response = await fetch(signalOrigin + path, { cache: "no-store", ...options, headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`);
  return body;
}

async function fetchIceServers() {
  try {
    const config = await api("/api/ice");
    if (Array.isArray(config.iceServers) && config.iceServers.length) return config.iceServers;
  } catch { /* Public STUN remains a usable fallback. */ }
  return FALLBACK_ICE;
}

function signalingUrl(room) {
  const url = new URL("/ws", signalOrigin || location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", room.room);
  url.searchParams.set("role", "host");
  url.searchParams.set("token", room.roomToken);
  return url;
}

function connectSignaling(room) {
  signaling?.close();
  signaling = new WebSocket(signalingUrl(room));
  signaling.addEventListener("open", () => status("Connected to signaling. Waiting for guests."));
  signaling.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleSignal(message).catch(error => status(error.message, true));
  });
  signaling.addEventListener("close", () => {
    for (const [port, peer] of peers) {
      if (peer.pc.connectionState !== "closed") updateSlotStatus(port, "connecting");
    }
    if (roomInfo === room) setTimeout(() => connectSignaling(room), 1000);
  });
  signaling.addEventListener("error", () => status("Signaling connection error; reconnecting…", true));
}

function sendSignal(payload) {
  if (!signaling || signaling.readyState !== WebSocket.OPEN) return false;
  signaling.send(JSON.stringify(payload));
  return true;
}

async function handleSignal(message) {
  if (message.type === "slot:connected") {
    const port = Number(message.port);
    if (![1, 2, 3, 4].includes(port) || !message.connectionId) return;
    const existing = peers.get(port);
    if (existing?.connectionId === message.connectionId && !["failed", "closed", "disconnected"].includes(existing.pc.connectionState)) return;
    // createPeer awaits (ICE servers, audio device); a replayed slot:connected for the same connection must not start a second peer.
    if (creatingPeers.get(port) === message.connectionId) return;
    creatingPeers.set(port, message.connectionId);
    try {
      closePeer(port, false);
      updateSlotStatus(port, "connecting");
      const peer = await createPeer(port, message.connectionId);
      if (creatingPeers.get(port) !== message.connectionId) { try { peer.pc.close(); } catch { /* superseded */ } clearInterval(peer.statsTimer); return; }
      peers.set(port, peer);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      sendSignal({ type: "offer", port, sdp: peer.pc.localDescription.sdp });
      peer.offerAt = performance.now();
    } finally { if (creatingPeers.get(port) === message.connectionId) creatingPeers.delete(port); }
  } else if (message.type === "slot:disconnected") {
    const peer = peers.get(Number(message.port));
    if (peer && (!message.connectionId || message.connectionId === peer.connectionId)) closePeer(Number(message.port));
  } else if (message.type === "answer") {
    const peer = peers.get(Number(message.port));
    if (!peer) return;
    if (peer.pc.signalingState === "have-local-offer") {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: tuneAnswer(message.sdp) });
      // The guest's host/srflx candidates arrive right behind its answer; they were dropped (forcing the TURN relay) when they beat it.
      for (const candidate of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  } else if (message.type === "ice") {
    const peer = peers.get(Number(message.port));
    if (peer && message.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate).catch(() => {});
      else peer.pendingIce.push(message.candidate);
    }
  } else if (message.type === "error") {
    if (message.code === "ROOM_NOT_FOUND") {
      sessionStorage.removeItem(STORAGE_KEY);
      roomInfo = null;
      status("Room expired. Reload this page to create a new room.", true);
    } else if (message.code !== "INVALID_OPERATION") status(message.message || message.code || "Signaling error", true); // INVALID_OPERATION answers the liveness probe
  }
}

async function createPeer(port, connectionId) {
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
  const videoTrack = stream?.getVideoTracks()[0] || null;
  const videoTransceiver = pc.addTransceiver(videoTrack || "video", { direction: "sendonly" });
  const peer = { pc, connectionId, pendingIce: [], channel: null, statsTimer: null, offerAt: 0, lastBytes: 0, lastStatsAt: 0, videoSender: videoTransceiver.sender };
  for (const track of stream?.getAudioTracks() || []) pc.addTrack(track, stream);
  if (tuning.audio) { const audio = await gameAudio(); if (audio) for (const track of audio.getAudioTracks()) pc.addTrack(track, audio); }
  const videoCodec = RTCRtpSender.getCapabilities?.("video")?.codecs?.filter(codec => /H264/i.test(codec.mimeType)) || [];
  if (videoCodec.length && typeof RTCRtpTransceiver !== "undefined" && RTCRtpTransceiver.prototype.setCodecPreferences) {
    videoTransceiver.setCodecPreferences([...videoCodec, ...RTCRtpSender.getCapabilities("video").codecs.filter(codec => !/H264/i.test(codec.mimeType))]);
  }
  const sender = videoTransceiver.sender;
  if (sender) {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = tuning.maxKbps * 1000;
      params.encodings[0].maxFramerate = 60;
      params.encodings[0].priority = "high";
      params.degradationPreference = "maintain-framerate";
      await sender.setParameters(params);
    } catch { /* Browser support varies. */ }
  }
  const meta = pc.createDataChannel("meta", { ordered: true });
  peer.meta = meta;
  meta.addEventListener("open", () => sendRoster(meta));
  meta.addEventListener("message", event => handleMeta(port, typeof event.data === "string" ? event.data : ""));
  const channel = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
  peer.channel = channel;
  channel.addEventListener("open", () => {
    updateSlotStatus(port, "connected");
    sendSidecar({ type: "slot:connect", port, connectionId });
  });
  channel.addEventListener("message", event => {
    let value;
    try { value = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)); } catch { return; }
    if (!validateInputMessage(value)) return;
    sendSidecar({ type: "slot:input", port, connectionId, input: value });
  });
  channel.addEventListener("close", () => {
    if (peers.get(port) === peer) closePeer(port);
  });
  pc.addEventListener("icecandidate", event => {
    if (event.candidate) sendSignal({ type: "ice", port, candidate: event.candidate.toJSON() });
  });
  pc.addEventListener("connectionstatechange", () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState) && peers.get(port) === peer) closePeer(port);
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    if (["failed", "closed"].includes(pc.iceConnectionState) && peers.get(port) === peer) closePeer(port);
  });
  peer.statsTimer = setInterval(() => collectStats(port, peer), 1000);
  ensureStatsCard(port);
  return peer;
}

function closePeer(port, announce = true) {
  const peer = peers.get(port);
  if (!peer) return;
  peers.delete(port);
  clearInterval(peer.statsTimer);
  if (announce) sendSidecar({ type: "slot:disconnect", port, connectionId: peer.connectionId });
  try { peer.channel?.close(); peer.pc.close(); } catch { /* already closed */ }
  updateSlotStatus(port, "empty");
}

async function collectStats(port, peer) {
  if (peers.get(port) !== peer) return;
  const reports = await peer.pc.getStats().catch(() => null);
  if (!reports) return;
  let outbound = null;
  let remote = null;
  peerRtcStats.set(port, [...reports.values()]);
  reports.forEach(report => {
    if (report.type === "outbound-rtp" && report.kind === "video" && !report.isRemote) outbound = report;
    if (report.type === "remote-inbound-rtp" && report.kind === "video") remote = report;
  });
  const now = performance.now();
  const bytes = outbound?.bytesSent || 0;
  const bitrate = peer.lastStatsAt ? Math.max(0, (bytes - peer.lastBytes) * 8 * 1000 / (now - peer.lastStatsAt)) : 0;
  peer.lastBytes = bytes;
  peer.lastStatsAt = now;
  const card = ensureStatsCard(port);
  card.querySelector(".rate").textContent = `${Number(outbound?.framesPerSecond || 0).toFixed(1)} fps · ${(bitrate / 1e6).toFixed(2)} Mbps`;
  card.querySelector(".encoding").textContent = `${outbound?.framesEncoded ?? 0} · ${outbound?.qualityLimitationReason || "none"}`;
  const pair = [...reports.values()].find(report => report.type === "candidate-pair" && report.state === "succeeded" && report.nominated);
  rtcStats.set(port, { rtt: remote?.roundTripTime != null ? remote.roundTripTime * 1000 : pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null, outboundFps: outbound?.framesPerSecond ?? null, bitrate, framesEncoded: outbound?.framesEncoded ?? null, qualityLimitationReason: outbound?.qualityLimitationReason ?? null });
  if (remote?.roundTripTime != null) updateSlotStatus(port, peer.channel?.readyState === "open" ? "connected" : "connecting", remote.roundTripTime * 1000);
}

function sendSidecar(message) {
  if (sidecar?.readyState === WebSocket.OPEN) sidecar.send(JSON.stringify(message));
  else if (message.type === "slot:connect") sidecarQueue.set(message.port, message);
}
const sidecarQueue = new Map();

function connectSidecar() {
  clearTimeout(sidecarRetry);
  if (sidecar && [WebSocket.OPEN, WebSocket.CONNECTING].includes(sidecar.readyState)) return;
  sidecar = new WebSocket(sidecarUrl);
  sidecar.addEventListener("open", () => {
    for (const [port, message] of sidecarQueue) sidecar.send(JSON.stringify(message));
    sidecarQueue.clear();
    for (const [port, peer] of peers) {
      if (peer.channel?.readyState === "open") sidecar.send(JSON.stringify({ type: "slot:connect", port, connectionId: peer.connectionId }));
    }
  });
  // The game acknowledged a Back to menu request (it only does during a match): tell every guest who ended it.
  sidecar.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message?.type !== "match:ended") return;
    for (const peer of peers.values()) if (peer.meta?.readyState === "open") peer.meta.send(JSON.stringify({ type: "match:ended", by: message.port }));
  });
  sidecar.addEventListener("close", () => { p1Connected = false; sidecarRetry = setTimeout(connectSidecar, 1000); });
  sidecar.addEventListener("error", () => { try { sidecar.close(); } catch { /* noop */ } });
}

function startCanvasCapture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext("2d");
  let frame = 0;
  const draw = () => {
    frame = (frame + 1) >>> 0;
    canvasFrame = frame;
    const timestamp = performance.timeOrigin + performance.now();
    canvasTimestamp = timestamp;
    context.fillStyle = "#08101c"; context.fillRect(0, 0, canvas.width, canvas.height);
    const barcode = new DataView(new ArrayBuffer(12));
    barcode.setUint32(0, frame, false);
    barcode.setFloat64(4, timestamp, false);
    for (let bit = 0; bit < 96; bit++) {
      const byte = barcode.getUint8(bit >>> 3);
      context.fillStyle = byte & (1 << (7 - (bit & 7))) ? "#fff" : "#000";
      context.fillRect(bit * 4, 0, 4, 12);
    }
    context.fillStyle = "#42e8a4"; context.font = "bold 80px monospace"; context.fillText(`FRAME ${frame}`, 70, 160);
    context.fillStyle = "#fff"; context.font = "30px monospace"; context.fillText(`${timestamp.toFixed(2)} ms epoch`, 70, 230);
    context.fillStyle = "#42e8a4";
    for (let i = 0; i < 100; i++) { const width = i % 7 === 0 ? 7 : 2; context.fillRect(70 + i * 10, 300, width, 170); }
  };
  draw();
  canvasTimer = setInterval(draw, 1000 / 60);
  const captured = canvas.captureStream(60);
  const videoTrack = captured.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = "motion";
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.015;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  for (const track of destination.stream.getAudioTracks()) captured.addTrack(track);
  captured._audioContext = audioContext;
  captured._oscillator = oscillator;
  return captured;
}

function hasLiveVideoTrack() {
  return Boolean(stream?.getVideoTracks().some(track => track.readyState === "live"));
}

function updateCaptureButton() {
  const available = Boolean(roomInfo) && !hasLiveVideoTrack();
  resumeButton.hidden = !available;
  resumeButton.disabled = !available;
  if (available) resumeButton.textContent = stream ? "Resume capture" : "Start capture";
  if (roomInfo) {
    startButton.textContent = "Room active";
    startButton.disabled = true;
  }
}

function stopStream(target) {
  if (!target) return;
  try { target._oscillator?.stop(); } catch { /* already stopped */ }
  target._audioContext?.close().catch(() => {});
  target.getTracks().forEach(track => track.stop());
}

async function startCapture(source) {
  const previousStream = stream;
  let nextStream;
  if (source === "canvas") {
    if (canvasTimer) clearInterval(canvasTimer);
    canvasTimer = null;
    nextStream = startCanvasCapture();
  } else {
    const captureOptions = { video: { frameRate: 60 }, audio: true, systemAudio: "include", surfaceSwitching: "include", selfBrowserSurface: "include" };
    nextStream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
    if (canvasTimer) clearInterval(canvasTimer);
    canvasTimer = null;
  }
  const videoTrack = nextStream.getVideoTracks()[0];
  if (!videoTrack) {
    stopStream(nextStream);
    throw new Error("Capture did not provide a video track");
  }
  for (const track of nextStream.getTracks()) if (track.kind === "video") track.contentHint = "motion";
  stream = nextStream;
  preview.srcObject = nextStream;
  videoTrack.addEventListener("ended", () => {
    if (stream !== nextStream) return;
    updateCaptureButton();
    status("Capture ended. Resume capture to continue.", true);
  });
  try {
    await Promise.all([...peers.values()].map(peer => peer.videoSender?.replaceTrack(videoTrack)));
  } catch (error) {
    stream = previousStream;
    preview.srcObject = previousStream;
    const previousVideoTrack = previousStream?.getVideoTracks()[0] || null;
    await Promise.all([...peers.values()].map(peer => peer.videoSender?.replaceTrack(previousVideoTrack).catch(() => {})));
    stopStream(nextStream);
    updateCaptureButton();
    throw error;
  }
  if (previousStream && previousStream !== nextStream) stopStream(previousStream);
  updateCaptureButton();
  return nextStream;
}

function stopCapture() {
  if (canvasTimer) clearInterval(canvasTimer);
  canvasTimer = null;
  const previousStream = stream;
  stream = null;
  preview.srcObject = null;
  stopStream(previousStream);
  updateCaptureButton();
}

async function createRoom() {
  startButton.disabled = true;
  try {
    roomInfo = { ...(await api("/api/rooms", { method: "POST", body: JSON.stringify(p1Guest ? { p1Guest: true } : {}) })), signal: signalOrigin };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(roomInfo));
    renderLinks(roomInfo.slots);
    connectSidecar();
    connectSignaling(roomInfo);
    updateCaptureButton();
    status(`Room ${roomInfo.room} created. Start capture to stream video.`);
  } catch (error) {
    status(error.message, true);
    startButton.disabled = false;
  }
}

function reattachRoom(room) {
  roomInfo = room;
  renderLinks(roomInfo.slots);
  connectSidecar();
  connectSignaling(roomInfo);
  updateCaptureButton();
  status(`Room ${roomInfo.room} reattached. Start capture to stream video.`);
}

startButton.addEventListener("click", () => createRoom());
resumeButton.addEventListener("click", async () => {
  try {
    await startCapture(sourceSelect.value);
    connectSidecar();
    if (!signaling || signaling.readyState > WebSocket.OPEN) connectSignaling(roomInfo);
    status("Capture resumed; room ready.");
  } catch (error) {
    updateCaptureButton();
    status(error.message, true);
  }
});
sourceSelect.addEventListener("change", () => {
  const url = new URL(location.href);
  if (sourceSelect.value === "canvas") url.searchParams.set("source", "canvas");
  else url.searchParams.delete("source");
  history.replaceState(null, "", url);
});

const p1Keys = new Set();
let p1Connected = false;
let lastP1Sent = 0;
const p1Toggle = document.querySelector("#p1-toggle");
if (p1Guest) p1Toggle.checked = false;
const p1Live = document.querySelector("#p1-live");
const GAME_CODES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Enter", "NumpadEnter"]);
// Layout-independent: event.code is the physical key, so a Hebrew/other layout still maps WASD/JKL.
const keyForCode = code => /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : code === "Space" || code === "NumpadEnter" ? "Enter" : code.startsWith("Arrow") || code === "Enter" ? code : null;
const textField = target => target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(target.type) && !target.readOnly);
window.addEventListener("keydown", event => {
  if (!p1Toggle.checked || textField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = keyForCode(event.code);
  if (!key) return;
  if (GAME_CODES.has(event.code) || /^Key[WASDJKLQEUNHI]$/.test(event.code)) event.preventDefault();
  p1Keys.add(event.code);
  pollGamepad();
});
window.addEventListener("keyup", event => { p1Keys.delete(event.code); pollGamepad(); });
window.addEventListener("blur", () => { p1Keys.clear(); pollGamepad(); });
p1Toggle.addEventListener("click", () => p1Toggle.blur());
document.addEventListener("click", event => { if (event.target.matches?.("button, input[type=checkbox], select")) setTimeout(() => event.target.blur?.(), 0); });

const BUTTON_NAMES = [[0x8000, "A"], [0x4000, "B"], [0x2000, "Z"], [0x1000, "Start"], [0x20, "L"], [0x10, "R"], [0x800, "Up"], [0x400, "Down"], [0x200, "Left"], [0x100, "Right"], [0x8, "C-up"]];
function renderP1(input) {
  if (!p1Live) return;
  const names = BUTTON_NAMES.filter(([mask]) => input.buttons & mask).map(([, name]) => name);
  const focus = document.hasFocus() ? "" : " | click this page so keys register";
  p1Live.textContent = `P1 ${p1Connected ? "connected" : "waiting for sidecar"} | stick ${input.sx},${input.sy} | buttons ${names.join("+") || "none"}${focus}`;
}

function pollGamepad() {
  if (!p1Toggle.checked) { lastGamepadState = null; return; }
  const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
  const keys = mapKeyboard(new Set([...p1Keys].map(keyForCode)));
  const padInput = pad ? mapGamepad(pad) : { buttons: 0, sx: 0, sy: 0 };
  if (!p1Connected && sidecar?.readyState === WebSocket.OPEN) { sendSidecar({ type: "slot:connect", port: 1, connectionId: "host-p1" }); p1Connected = true; lastGamepadState = null; }
  if (!p1Connected) { renderP1({ buttons: 0, sx: 0, sy: 0 }); return; }
  const merged = { buttons: padInput.buttons | keys.buttons, sx: padInput.sx || keys.sx, sy: padInput.sy || keys.sy };
  renderP1(merged);
  const now = performance.now();
  const changed = !lastGamepadState || merged.buttons !== lastGamepadState.buttons || merged.sx !== lastGamepadState.sx || merged.sy !== lastGamepadState.sy;
  // The sidecar neutralizes a kind-3 port after 500 ms of silence, so held input needs a keep-alive.
  if (!changed && now - lastP1Sent < 100) return;
  const input = clampInputMessage({ seq: (hostConnectionSequence++ >>> 0), t: now, ...merged });
  sendSidecar({ type: "slot:input", port: 1, connectionId: "host-p1", input });
  lastGamepadState = input;
  lastP1Sent = now;
}

p1Toggle.addEventListener("change", event => {
  if (!event.target.checked && p1Connected) {
    sendSidecar({ type: "slot:disconnect", port: 1, connectionId: "host-p1" });
    p1Connected = false;
    lastGamepadState = null;
  }
});

gamepadTimer = setInterval(pollGamepad, 1000 / 60);
connectSidecar();
const query = new URLSearchParams(location.search);
if (query.get("source") === "canvas") sourceSelect.value = "canvas";
try {
  const seeded = window.__SMASH_E2E_ROOM__;
  if (seeded?.room && seeded?.roomToken) {
    roomInfo = { room: seeded.room, roomToken: seeded.roomToken, slots: [] };
    startButton.hidden = true;
    sourceSelect.value = "canvas";
    startCapture("canvas").then(() => { connectSidecar(); connectSignaling(roomInfo); status("Harness room attached."); }).catch(error => status(error.message, true));
  }
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
  if (saved?.room && saved?.roomToken && Array.isArray(saved.slots)) reattachRoom(saved);
} catch { sessionStorage.removeItem(STORAGE_KEY); }

// After a VM suspend/resume the signaling socket can look open and be dead. The Worker answers any unknown message with an
// INVALID_OPERATION error, so a reply within 1.5 s proves the socket (and the room behind it) is alive.
window.__smashSignalProbe = () => new Promise(resolve => {
  if (signaling?.readyState !== WebSocket.OPEN) return resolve(false);
  const socket = signaling;
  const done = value => { clearTimeout(timer); socket.removeEventListener("message", onMessage); resolve(value); };
  const onMessage = event => { try { if (JSON.parse(event.data).code === "INVALID_OPERATION") done(true); } catch { /* not ours */ } };
  const timer = setTimeout(() => done(false), 1500);
  socket.addEventListener("message", onMessage);
  sendSignal({ type: "probe" });
});
window.__smashHostP1 = () => ({ connected: p1Connected, enabled: p1Toggle.checked, last: lastGamepadState });
window.__smashHostStats = () => ({
  room: roomInfo?.room || null,
  signalingState: signaling?.readyState ?? null,
  frame: canvasFrame,
  timestamp: canvasTimestamp,
  video: { frame: canvasFrame, timestamp: canvasTimestamp, captured: hasLiveVideoTrack() },
  slots: Object.fromEntries([...statuses].map(([port, value]) => [port, { ...value }])),
  peers: Object.fromEntries([...peers].map(([port, peer]) => [port, { state: peer.pc.connectionState, dataChannel: peer.channel?.readyState, videoTrackId: peer.videoSender?.track?.id || null, rtcStats: peerRtcStats.get(port) || [], summary: rtcStats.get(port) || null }])),
  rtcStats: [...peers.keys()].flatMap(port => (peerRtcStats.get(port) || []).map(report => ({ ...report, port }))),
  capturedTracks: stream?.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState, contentHint: track.contentHint })) || [],
  source: sourceSelect.value,
});
if (query.get("testHooks") === "1") {
  const p1ConnectionId = "smash-e2e-p1";
  let p1Connected = false;
  window.__smashHostSetP1Input = async (input) => {
    const deadline = Date.now() + 3000;
    while (sidecar?.readyState !== WebSocket.OPEN && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    if (sidecar?.readyState !== WebSocket.OPEN) throw new Error("Sidecar is not connected");
    if (!p1Connected) {
      sendSidecar({ type: "slot:connect", port: 1, connectionId: p1ConnectionId });
      p1Connected = true;
    }
    const packet = clampInputMessage({ seq: hostConnectionSequence++ >>> 0, t: performance.now(), ...input });
    sendSidecar({ type: "slot:input", port: 1, connectionId: p1ConnectionId, input: packet });
    return packet;
  };
  window.__smashHostDisconnectP1 = () => {
    if (!p1Connected) return;
    sendSidecar({ type: "slot:disconnect", port: 1, connectionId: p1ConnectionId });
    p1Connected = false;
  };
}
window.addEventListener("pagehide", () => {
  clearInterval(gamepadTimer);
  clearTimeout(sidecarRetry);
  for (const port of peers.keys()) closePeer(port);
  signaling?.close(); sidecar?.close(); stopCapture();
});
