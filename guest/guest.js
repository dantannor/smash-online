import { mapGamepad, mapKeyboard, logicalKeys } from './input-map.js';
import { clampInputMessage } from '../shared/protocol.js';

const video = document.querySelector('#video');
const hint = document.querySelector('#hint');
const connection = document.querySelector('#connection');
const slotLabel = document.querySelector('#slot');
const params = new URLSearchParams(location.search);
const room = params.get('room');
const slotToken = params.get('slot');
const keyState = new Set();
const state = { connection: 'connecting', connected: false, slot: null, port: null, controller: 'Keyboard', ping: null, fps: null, error: null };
let peer, ws, dataChannel, stream;
let soundOn = false; // autoplay needs a user gesture: any first click or key press turns sound on
let reconnectTimer, reconnectDelay = 500, generation = 0, sequence = 0;
let virtualInput = null;
let lastInput = { buttons: 0, sx: 0, sy: 0 };
let lastEncoded = '';
let statsTimer;
let stopping = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const relayOnly = params.get('relay') === '1';
let disconnectTimer;

function setState(value, error = null) {
  state.connection = value;
  state.connected = value === 'Connected';
  state.error = error;
  connection.textContent = error ? `${value}: ${error}` : value;
  connection.classList.toggle('error', Boolean(error));
}
function clampInput(value) {
  const { buttons, sx, sy } = clampInputMessage({ seq: 0, t: 0, ...value });
  return { buttons, sx, sy };
}
function encodeInput(value) {
  return JSON.stringify(clampInputMessage({ seq: sequence = (sequence + 1) >>> 0, t: performance.now(), ...value }));
}
function getInput() {
  if (virtualInput) return clampInput(virtualInput);
  const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
  if (pad) {
    state.controller = pad.id || 'Gamepad';
    return merge(mapGamepad(pad), mapKeyboard(logicalKeys(keyState)));
  }
  state.controller = 'Keyboard';
  return mapKeyboard(logicalKeys(keyState));
}
function merge(a, b) { return { buttons: a.buttons | b.buttons, sx: a.sx || b.sx, sy: a.sy || b.sy }; }
function updateController() { document.querySelector('#controller').textContent = `Controller: ${state.controller}`; }
function sendInput(force = false) {
  const next = clampInput(getInput());
  lastInput = next;
  updateController();
  const signature = `${next.buttons}/${next.sx}/${next.sy}`;
  if (!force && signature === lastEncoded) return;
  lastEncoded = signature;
  if (dataChannel?.readyState !== 'open') return;
  try { dataChannel.send(encodeInput(next)); } catch { /* closed between check and send */ }
}
function setVirtualInput(value) { virtualInput = clampInput(value); sendInput(true); return { ...virtualInput }; }
function closeConnection() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (dataChannel) { dataChannel.onopen = dataChannel.onclose = dataChannel.onerror = null; try { dataChannel.close(); } catch {} }
  dataChannel = null;
  if (peer) { peer.onicecandidate = peer.ontrack = peer.ondatachannel = peer.onconnectionstatechange = null; try { peer.close(); } catch {} }
  peer = null;
  if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} }
  ws = null;
}
function stopForReplacement() {
  stopping = true;
  clearTimeout(reconnectTimer); clearTimeout(disconnectTimer);
  closeConnection();
  setState('Replaced', 'This link is open in another tab');
  hint.hidden = false; hint.textContent = 'This link is open in another tab. Close the other tab, then reload this one.';
}
function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return;
  setState('Reconnecting', reason || null);
  closeConnection();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(10000, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}
async function connect() {
  const ownGeneration = ++generation;
  if (!room || !slotToken) { setState('Invalid link', 'missing room or slot'); hint.textContent = 'This link is missing its room or slot token.'; return; }
  setState('Joining');
  try {
    try {
      const ice = await (await fetch('/api/ice', { cache: 'no-store' })).json();
      if (Array.isArray(ice.iceServers) && ice.iceServers.length) iceServers = ice.iceServers;
    } catch { /* default STUN stays */ }
    const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slotToken }),
    });
    if (!response.ok) throw new Error(`Join failed (${response.status})`);
    const joined = await response.json();
    if (ownGeneration !== generation) return;
    const port = Number(joined.port);
    if (![1, 2, 3, 4].includes(port)) throw new Error('Join returned an invalid slot');
    state.slot = port; state.port = port; slotLabel.textContent = `P${port}`;
    const wsUrl = new URL('/ws', location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('room', room); wsUrl.searchParams.set('role', 'guest');
    wsUrl.searchParams.set('token', slotToken); wsUrl.searchParams.set('port', String(port));
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { if (ownGeneration === generation) setState('Signaling connected'); };
    ws.onmessage = (event) => { if (ownGeneration === generation) void handleSignal(event.data, ownGeneration); };
    ws.onerror = () => { if (ownGeneration === generation) scheduleReconnect('signaling error'); };
    ws.onclose = (event) => { if (ownGeneration !== generation) return; if (event.code === 4001) stopForReplacement(); else scheduleReconnect('signaling closed'); };
  } catch (error) {
    if (ownGeneration === generation) scheduleReconnect(error?.message || 'join failed');
  }
}
async function handleSignal(raw, ownGeneration) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'error' && message.code === 'SLOT_REPLACED') { stopForReplacement(); return; }
  if (message.type === 'error') { scheduleReconnect(message.message || message.code || 'signaling rejected'); return; }
  if (message.type === 'ice' && message.candidate) {
    try {
      const candidate = new RTCIceCandidate(message.candidate);
      if (peer?.remoteDescription) await peer.addIceCandidate(candidate); else pendingIce.push(candidate);
    } catch { /* stale or unsupported ICE candidate */ }
    return;
  }
  if (message.type !== 'offer' || !message.sdp) return;
  try {
    if (!peer) createPeer(ownGeneration);
    await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    for (const candidate of pendingIce.splice(0)) await peer.addIceCandidate(candidate);
    const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
    ws?.send(JSON.stringify({ type: 'answer', sdp: peer.localDescription.sdp }));
  } catch (error) { scheduleReconnect(error?.message || 'offer failed'); }
}
const pendingIce = [];
function createPeer(ownGeneration) {
  peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ice', candidate }));
  };
  stream = new MediaStream(); // video and audio arrive as separate tracks; play them through one element
  peer.ontrack = async ({ track }) => {
    stream.addTrack(track);
    video.srcObject = stream; video.playsInline = true; video.muted = !soundOn;
    if (track.kind === 'video') setReceiverLatency(track);
    hint.hidden = true;
    try { await video.play(); } catch { hint.hidden = false; hint.textContent = 'Video is ready. Tap the screen to start playback.'; }
  };
  peer.ondatachannel = ({ channel }) => {
    if (channel.label !== 'input') { channel.close(); return; }
    dataChannel = channel;
    channel.onopen = () => { if (ownGeneration === generation) { reconnectDelay = 500; setState('Connected'); sendInput(true); } };
    channel.onclose = () => { if (ownGeneration === generation) scheduleReconnect('input channel closed'); };
    channel.onerror = () => { if (ownGeneration === generation) scheduleReconnect('input channel error'); };
  };
  peer.onconnectionstatechange = () => {
    if (ownGeneration !== generation) return;
    clearTimeout(disconnectTimer);
    // 'disconnected' is usually transient ICE churn; only tear down if it persists.
    if (peer?.connectionState === 'disconnected') disconnectTimer = setTimeout(() => { if (ownGeneration === generation && peer?.connectionState === 'disconnected') scheduleReconnect('peer disconnected'); }, 8000);
    else if (['failed', 'closed'].includes(peer?.connectionState)) scheduleReconnect(`peer ${peer.connectionState}`);
    else if (peer?.connectionState === 'connected' && !dataChannel) setState('Peer connected');
  };
  statsTimer = setInterval(() => void readStats(), 1000);
}
function setReceiverLatency(track) {
  try {
    const receiver = peer?.getReceivers().find(item => item.track?.id === track.id);
    if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    if (receiver && 'playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
  } catch { /* best effort */ }
}
async function readStats() {
  if (!peer) return;
  try {
    const report = await peer.getStats();
    let rtt = null, fps = null;
    report.forEach(item => {
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated && Number.isFinite(item.currentRoundTripTime)) rtt = item.currentRoundTripTime * 1000;
      if (item.type === 'inbound-rtp' && item.kind === 'video' && Number.isFinite(item.framesPerSecond)) fps = item.framesPerSecond;
    });
    state.ping = rtt; state.fps = fps;
    document.querySelector('#ping').textContent = `RTT: ${rtt == null ? '--' : `${Math.round(rtt)} ms`}`;
    document.querySelector('#fps').textContent = `FPS: ${fps == null ? '--' : Math.round(fps)}`;
  } catch { /* stats are diagnostic only */ }
}
const GAME_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
window.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return; // browser shortcuts: their keyups never arrive
  if (GAME_CODES.has(event.code)) event.preventDefault();
  keyState.add(event.code); sendInput();
});
window.addEventListener('keyup', event => { keyState.delete(event.code); sendInput(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keyState.clear(); sendInput(true); } });
window.addEventListener('blur', () => { keyState.clear(); sendInput(true); });
window.addEventListener('gamepadconnected', () => sendInput(true));
window.addEventListener('gamepaddisconnected', () => sendInput(true));
video.addEventListener('playing', () => { hint.hidden = true; });
const soundButton = document.querySelector('#sound');
async function enableSound() { soundOn = true; video.muted = false; soundButton.textContent = 'Sound on'; try { await video.play(); } catch {} }
soundButton.addEventListener('click', enableSound);
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { if (!soundOn) enableSound(); }, { once: true });
const screenEl = document.querySelector('#screen');
const fullscreenButton = document.querySelector('#fullscreen');
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
// The video container goes fullscreen (so the hint and letterboxing stay ours); iPhone Safari only allows the <video> itself.
async function toggleFullscreen() {
  try {
    if (fullscreenElement()) { await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); return; }
    if (screenEl.requestFullscreen) await screenEl.requestFullscreen({ navigationUI: 'hide' });
    else if (screenEl.webkitRequestFullscreen) screenEl.webkitRequestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  } catch { try { video.webkitEnterFullscreen?.(); } catch { /* not available */ } }
}
fullscreenButton.addEventListener('click', toggleFullscreen);
for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, () => { fullscreenButton.textContent = fullscreenElement() ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'; });
window.addEventListener('keydown', event => { if (event.code === 'KeyF' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) toggleFullscreen(); });
setInterval(() => sendInput(true), 1000 / 60);
window.__smashGuest = { state, stats: async () => ({ ...state, rtcStats: peer ? [...(await peer.getStats()).values()] : [] }), get lastInput() { return { ...lastInput }; }, setVirtualInput };
if (params.get('fakeInput') === 'script') {
  let tick = 0; setInterval(() => { tick++; setVirtualInput({ buttons: tick % 2 ? 0x8000 : 0, sx: tick % 2 ? 30 : -30, sy: 0 }); }, 500);
}
connect();
