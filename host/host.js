import { validateInputMessage } from "../shared/protocol.js";

const STORAGE_KEY = "smash-host-room";
const FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const statusEl = document.querySelector("#status");
const linksEl = document.querySelector("#guest-links");
const statsEl = document.querySelector("#stats");
const preview = document.querySelector("#preview");
const startButton = document.querySelector("#start");
const resumeButton = document.querySelector("#resume");
const sourceSelect = document.querySelector("#source");
const peers = new Map();
const statuses = new Map([2, 3, 4].map(port => [port, { status: "empty", ping: null }]));
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
  const response = await fetch(path, { cache: "no-store", ...options, headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers });
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
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
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
    if (![2, 3, 4].includes(port) || !message.connectionId) return;
    closePeer(port, false);
    updateSlotStatus(port, "connecting");
    const peer = await createPeer(port, message.connectionId);
    peers.set(port, peer);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    sendSignal({ type: "offer", port, sdp: peer.pc.localDescription.sdp });
    peer.offerAt = performance.now();
  } else if (message.type === "slot:disconnected") {
    const peer = peers.get(Number(message.port));
    if (peer && (!message.connectionId || message.connectionId === peer.connectionId)) closePeer(Number(message.port));
  } else if (message.type === "answer") {
    const peer = peers.get(Number(message.port));
    if (!peer) return;
    if (peer.pc.signalingState === "have-local-offer") await peer.pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
  } else if (message.type === "ice") {
    const peer = peers.get(Number(message.port));
    if (peer && message.candidate) await peer.pc.addIceCandidate(message.candidate).catch(() => {});
  } else if (message.type === "error") status(message.message || message.code || "Signaling error", true);
}

async function createPeer(port, connectionId) {
  if (!stream) throw new Error("Start capture before connecting guests.");
  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
  const peer = { pc, connectionId, channel: null, statsTimer: null, offerAt: 0, lastBytes: 0, lastStatsAt: 0 };
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  const videoCodec = RTCRtpSender.getCapabilities?.("video")?.codecs?.filter(codec => /H264/i.test(codec.mimeType)) || [];
  if (videoCodec.length && typeof RTCRtpTransceiver !== "undefined" && RTCRtpTransceiver.prototype.setCodecPreferences) {
    const transceiver = pc.getTransceivers().find(item => item.sender.track?.kind === "video");
    transceiver?.setCodecPreferences([...videoCodec, ...RTCRtpSender.getCapabilities("video").codecs.filter(codec => !/H264/i.test(codec.mimeType))]);
  }
  const sender = pc.getSenders().find(item => item.track?.kind === "video");
  if (sender) {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = 6_000_000;
      params.encodings[0].maxFramerate = 60;
      params.encodings[0].priority = "high";
      params.degradationPreference = "maintain-framerate";
      await sender.setParameters(params);
    } catch { /* Browser support varies. */ }
  }
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
  sidecar.addEventListener("close", () => { sidecarRetry = setTimeout(connectSidecar, 1000); });
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
      context.fillRect(bit, 0, 1, 12);
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

async function startCapture(source) {
  stopCapture();
  if (source === "canvas") stream = startCanvasCapture();
  else {
    const captureOptions = { video: { frameRate: 60 }, audio: true, systemAudio: "include", surfaceSwitching: "include", selfBrowserSurface: "include" };
    stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
  }
  for (const track of stream.getTracks()) if (track.kind === "video") track.contentHint = "motion";
  preview.srcObject = stream;
  stream.getVideoTracks()[0]?.addEventListener("ended", () => status("Capture ended. Resume capture to continue.", true));
}

function stopCapture() {
  if (canvasTimer) clearInterval(canvasTimer);
  canvasTimer = null;
  if (stream) {
    stream._oscillator?.stop();
    stream._audioContext?.close().catch(() => {});
    stream.getTracks().forEach(track => track.stop());
  }
  stream = null;
  preview.srcObject = null;
}

async function createRoom({ existing = false } = {}) {
  startButton.disabled = true;
  try {
    if (existing) {
      const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      roomInfo = stored;
      renderLinks(stored.slots);
    } else {
      roomInfo = await api("/api/rooms", { method: "POST", body: "{}" });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(roomInfo));
      renderLinks(roomInfo.slots);
    }
    await startCapture(sourceSelect.value);
    connectSidecar();
    connectSignaling(roomInfo);
    resumeButton.hidden = true;
    startButton.textContent = "Room active";
    status(`Room ${roomInfo.room} ready. Share a guest link.`);
  } catch (error) {
    status(error.message, true);
    startButton.disabled = false;
    if (roomInfo) resumeButton.hidden = false;
  }
}

startButton.addEventListener("click", () => createRoom());
resumeButton.addEventListener("click", async () => {
  try {
    await startCapture(sourceSelect.value);
    connectSidecar();
    if (!signaling || signaling.readyState > WebSocket.OPEN) connectSignaling(roomInfo);
    resumeButton.hidden = true;
    status("Capture resumed; room reattached.");
  } catch (error) { status(error.message, true); }
});
sourceSelect.addEventListener("change", () => {
  const url = new URL(location.href);
  if (sourceSelect.value === "canvas") url.searchParams.set("source", "canvas");
  else url.searchParams.delete("source");
  history.replaceState(null, "", url);
});

function pollGamepad() {
  if (!document.querySelector("#p1-toggle").checked) { lastGamepadState = null; return; }
  const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
  if (!pad) return;
  if (!lastGamepadState) sendSidecar({ type: "slot:connect", port: 1, connectionId: "host-p1" });
  const buttons = pad.buttons.reduce((mask, button, index) => button.pressed ? mask | (index < 16 ? 1 << (15 - index) : 0) : mask, 0);
  const input = { seq: (hostConnectionSequence++ >>> 0), t: performance.now(), buttons, sx: Math.round((pad.axes[0] || 0) * 80), sy: Math.round((pad.axes[1] || 0) * 80) };
  if (JSON.stringify(input) !== JSON.stringify(lastGamepadState)) {
    sendSidecar({ type: "slot:input", port: 1, connectionId: "host-p1", input });
    lastGamepadState = input;
  }
}

document.querySelector("#p1-toggle").addEventListener("change", event => {
  if (!event.target.checked && lastGamepadState) {
    sendSidecar({ type: "slot:disconnect", port: 1, connectionId: "host-p1" });
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
  if (saved?.room && saved?.roomToken && Array.isArray(saved.slots)) {
    roomInfo = saved;
    renderLinks(saved.slots);
    startButton.textContent = "Reattach room";
    resumeButton.hidden = false;
    createRoom({ existing: true });
  }
} catch { sessionStorage.removeItem(STORAGE_KEY); }

window.__smashHostStats = () => ({
  frame: canvasFrame,
  timestamp: canvasTimestamp,
  video: { frame: canvasFrame, timestamp: canvasTimestamp, captured: Boolean(stream?.getVideoTracks().length) },
  slots: Object.fromEntries([...statuses].map(([port, value]) => [port, { ...value }])),
  peers: Object.fromEntries([...peers].map(([port, peer]) => [port, { state: peer.pc.connectionState, dataChannel: peer.channel?.readyState, rtcStats: rtcStats.get(port) || null }])),
  capturedTracks: stream?.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState, contentHint: track.contentHint })) || [],
  source: sourceSelect.value,
});
window.addEventListener("pagehide", () => {
  clearInterval(gamepadTimer);
  clearTimeout(sidecarRetry);
  for (const port of peers.keys()) closePeer(port);
  signaling?.close(); sidecar?.close(); stopCapture();
});
