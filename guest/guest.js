import { mapGamepad, mapKeyboard, logicalKeys } from './input-map.js';
import { clampInputMessage } from '../shared/protocol.js';
import { snapshotStats, diffSample, overlayText } from '../shared/telemetry.js';

const video = document.querySelector('#video');
const audio = document.querySelector('#audio');
const hint = document.querySelector('#hint');
const connection = document.querySelector('#connection');
const slotLabel = document.querySelector('#slot');
const params = new URLSearchParams(location.search);
const room = params.get('room');
const slotToken = params.get('slot');
const keyState = new Set();
const state = { connection: 'connecting', connected: false, slot: null, port: null, controller: 'Keyboard', ping: null, fps: null, error: null };
let offerWatchdog, missedOffers = 0;
let metaChannel = null; // reliable side channel from the host (fighter finder)
let peer, ws, dataChannel, videoStream, audioStream;
// The video is always muted (so it autoplays everywhere); the game's audio plays through a separate element. Sound is on by default:
// the browser only allows it after a gesture, so the first click, tap or key press anywhere on the page unlocks it. A player who
// switched sound off with the toggle stays muted across reloads (localStorage).
let soundUnlocked = false;
let soundMuted = false;
try { soundMuted = localStorage.getItem('smash-muted') === '1'; } catch { /* storage unavailable: sound stays on */ }
let reconnectTimer, reconnectDelay = 500, generation = 0, sequence = 0;
let virtualInput = null;
let lastInput = { buttons: 0, sx: 0, sy: 0 };
let lastEncoded = '';
let statsTimer;
// Session telemetry (see shared/telemetry.js). readStats already runs once a second; every 5th tick sends one sample to the host
// over the reliable meta channel. Input cost is one counter increment per send; nothing runs per frame.
const TELEMETRY_EVERY = 5;
const telemetry = { ticks: 0, sends: 0, bufferedMax: 0, prevLive: null, prevSent: null, live: null };
const statsOverlay = document.querySelector('#stats-overlay');
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
  try { dataChannel.send(encodeInput(next)); telemetry.sends++; telemetry.bufferedMax = Math.max(telemetry.bufferedMax, dataChannel.bufferedAmount); } catch { /* closed between check and send */ }
}
function setVirtualInput(value) { virtualInput = clampInput(value); sendInput(true); return { ...virtualInput }; }
function closeConnection() {
  Object.assign(telemetry, { ticks: 0, sends: 0, bufferedMax: 0, prevLive: null, prevSent: null, live: null });
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (dataChannel) { dataChannel.onopen = dataChannel.onclose = dataChannel.onerror = null; try { dataChannel.close(); } catch {} }
  dataChannel = null;
  if (peer) { peer.onicecandidate = peer.ontrack = peer.ondatachannel = peer.onconnectionstatechange = null; try { peer.close(); } catch {} }
  peer = null;
  metaChannel = null;
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
    if (response.status === 404) {
      // The room is gone (its 30 min expired while the VM slept, or the host restarted into a new one): retrying the same link can
      // never work. Go back through the permanent link, which wakes the VM and hands out the current room.
      const entry = sessionStorage.getItem('smash-entry');
      if (entry && ownGeneration === generation) { location.replace(entry); return; }
      // No permanent link to go back through (a bare play URL): stop for good, retrying a dead room would loop forever.
      stopping = true;
      clearTimeout(reconnectTimer); clearTimeout(disconnectTimer);
      closeConnection();
      setState('Game ended', 'this room no longer exists');
      hint.hidden = false; hint.textContent = 'This game has ended. Open your permanent link again to start a new one.';
      return;
    }
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
    ws.onopen = () => {
      if (ownGeneration !== generation) return;
      setState('Signaling connected');
      // The host answers a connected slot with an offer within a second or two; if it never does (it was busy starting up, or lost
      // the slot:connected), reconnect so the host sees this slot connect again instead of waiting on it forever.
      clearTimeout(offerWatchdog);
      offerWatchdog = setTimeout(() => {
        if (ownGeneration !== generation || state.connected) return;
        // Twice in a row means the room itself is gone (the host restarted into a new one): go back through the permanent link,
        // which hands out the current room. Direct room links have no entry point, so those just keep retrying.
        if (++missedOffers >= 2 && sessionStorage.getItem('smash-entry')) { location.replace(sessionStorage.getItem('smash-entry')); return; }
        scheduleReconnect('no offer from the host');
      }, 12000);
    };
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
function attachStreams() {
  if (video.srcObject !== videoStream) video.srcObject = videoStream; // re-attach after a renegotiation or a new peer
  video.muted = true; video.playsInline = true;
  if (audio.srcObject !== audioStream) audio.srcObject = audioStream;
}
const videoIsPlaying = () => !video.paused && !video.ended && video.readyState >= 2;
function showPlayHint() { if (!videoIsPlaying() && video.srcObject) { hint.hidden = false; hint.textContent = 'Video is ready. Tap the screen to start playback.'; } }
// Safe to call from anywhere (gestures, track events, visibility): starts whatever is not playing yet. The hint is only
// ever driven by the element's real state, never by a play() promise that a later load can reject after playback began.
async function ensurePlaying() {
  if (!video.srcObject) return;
  video.muted = true;
  if (video.paused) { try { await video.play(); } catch { /* shown below if it is still stopped */ } }
  audio.muted = soundMuted;
  if (soundUnlocked && !soundMuted && audioStream?.getAudioTracks().length && audio.paused) { try { await audio.play(); } catch { /* retried on the next gesture */ } }
  if (videoIsPlaying()) hint.hidden = true; else showPlayHint();
}
function createPeer(ownGeneration) {
  peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ice', candidate }));
  };
  // Video and audio play through separate elements: the muted video never waits on an audio gesture (Safari/WebKit autoplay rules).
  videoStream = new MediaStream(); audioStream = new MediaStream();
  peer.ontrack = ({ track }) => {
    if (track.kind === 'video') { videoStream.addTrack(track); setReceiverLatency(track); } else audioStream.addTrack(track);
    track.onunmute = () => ensurePlaying();
    attachStreams();
    ensurePlaying();
  };
  peer.ondatachannel = ({ channel }) => {
    if (channel.label === 'meta') { attachMeta(channel); return; }
    if (channel.label !== 'input') { channel.close(); return; }
    dataChannel = channel;
    channel.onopen = () => { if (ownGeneration === generation) { reconnectDelay = 500; missedOffers = 0; setState('Connected'); sendInput(true); } };
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
function trackTelemetry(report) {
  const snap = snapshotStats(report, { sends: telemetry.sends, buffered: dataChannel?.bufferedAmount ?? 0 });
  const buffered = Math.max(telemetry.bufferedMax, snap.inputBuffered);
  telemetry.live = diffSample(telemetry.prevLive, snap, buffered);
  telemetry.prevLive = snap;
  if (!statsOverlay.hidden) statsOverlay.textContent = overlayText(telemetry.live);
  if (++telemetry.ticks % TELEMETRY_EVERY !== 0) return;
  const sample = diffSample(telemetry.prevSent, snap, buffered);
  telemetry.prevSent = snap;
  telemetry.bufferedMax = 0;
  if (sample) sendMeta({ type: 'telemetry', ...sample });
}
function setStatsOverlay(show) { statsOverlay.hidden = !show; if (show) statsOverlay.textContent = overlayText(telemetry.live); }
if (params.get('stats') === '1') setStatsOverlay(true);
window.addEventListener('keydown', event => { if (event.code === 'Backquote' && !typingTarget(event) && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) setStatsOverlay(statsOverlay.hidden); });
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
    trackTelemetry(report);
    document.querySelector('#ping').textContent = `RTT: ${rtt == null ? '--' : `${Math.round(rtt)} ms`}`;
    document.querySelector('#fps').textContent = `FPS: ${fps == null ? '--' : Math.round(fps)}`;
  } catch { /* stats are diagnostic only */ }
}
const GAME_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
// The page scrolls (video on top, fighter grid below), so the game only owns the keys while focus is not on the search box or a
// fighter tile (there arrows, space and Enter keep their normal meaning). Picking a fighter, or any button click, drops focus.
const typingOrGrid = event => typingTarget(event) || (event.target instanceof Element && event.target.closest('#fighter-grid') !== null);
window.addEventListener('keydown', event => {
  if (typingOrGrid(event)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return; // browser shortcuts: their keyups never arrive
  if (GAME_CODES.has(event.code)) event.preventDefault(); // no page scroll while playing
  keyState.add(event.code); sendInput();
});
window.addEventListener('keyup', event => { if (typingOrGrid(event)) return; keyState.delete(event.code); sendInput(); });
// Moving focus into the search box or the grid must not leave a held key stuck in the game.
document.addEventListener('focusin', event => { if (typingOrGrid(event) && keyState.size) { keyState.clear(); sendInput(true); } });
document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('button.action')) event.target.closest('button.action').blur(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keyState.clear(); sendInput(true); } else void ensurePlaying(); });
window.addEventListener('blur', () => { keyState.clear(); sendInput(true); });
window.addEventListener('gamepadconnected', () => sendInput(true));
window.addEventListener('gamepaddisconnected', () => sendInput(true));
for (const type of ['playing', 'loadedmetadata', 'loadeddata', 'canplay', 'pause', 'emptied', 'stalled']) video.addEventListener(type, () => { if (type === 'playing') hint.hidden = true; else void ensurePlaying(); });
video.addEventListener('timeupdate', () => { if (!hint.hidden && videoIsPlaying()) hint.hidden = true; });
const soundButton = document.querySelector('#sound');
function renderSound() { soundButton.textContent = soundMuted ? 'Sound off' : 'Sound on'; soundButton.setAttribute('aria-pressed', String(!soundMuted)); }
function setMuted(muted) {
  soundMuted = muted;
  try { localStorage.setItem('smash-muted', muted ? '1' : '0'); } catch { /* not remembered */ }
  renderSound();
  return ensurePlaying();
}
renderSound();
// The toggle: unmutes when muted, mutes when playing. (A click before the first gesture counts as that gesture and keeps sound on.)
soundButton.addEventListener('click', () => {
  if (soundMuted) { soundUnlocked = true; void setMuted(false); }
  else if (!soundUnlocked) { soundUnlocked = true; void ensurePlaying(); }
  else void setMuted(true);
});
// Any other gesture (click, tap, key press) starts playback and unlocks sound unless the player muted it; later ones retry if something is still stopped.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) window.addEventListener(type, event => { if (event.target instanceof Element && event.target.closest('#sound')) return; soundUnlocked = true; void ensurePlaying(); }, { capture: true });
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
fullscreenButton.addEventListener('click', () => { void ensurePlaying(); toggleFullscreen(); });
for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, () => { fullscreenButton.textContent = fullscreenElement() ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'; });
window.addEventListener('keydown', event => { if (event.code === 'KeyF' && !typingOrGrid(event) && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) toggleFullscreen(); });
setInterval(() => sendInput(true), 1000 / 60);
window.__smashGuest = { state, ensurePlaying, attachMeta, stats: async () => ({ ...state, rtcStats: peer ? [...(await peer.getStats()).values()] : [] }), get lastInput() { return { ...lastInput }; }, get telemetry() { return { ...telemetry }; }, get sound() { return { unlocked: soundUnlocked, muted: soundMuted }; }, setVirtualInput };
if (params.get('fakeInput') === 'script') {
  let tick = 0; setInterval(() => { tick++; setVirtualInput({ buttons: tick % 2 ? 0x8000 : 0, sx: tick % 2 ? 30 : -30, sy: 0 }); }, 500);
}
connect();

// ---- fighter grid ---------------------------------------------------------------------------------------------
// Like smash.fun: every fighter on the same scrolling page, under the video, with search. The host sends the roster over a reliable
// "meta" channel (originals as name tiles, custom fighters with smash.fun's public portrait assets); a click asks the host to put that
// fighter on THIS player's port in the game's character select (host page -> sidecar -> file the game polls).
const TILE_FKINDS = [4, 0, 2, 5, 3, 7, 11, 6, 8, 1, 9, 10]; // original on character-select tile i (left to right, top row first) -> game fighter kind
const PORTRAIT_BASE = 'https://storage.googleapis.com/smash-the-weights-fighter-assets/baked/v1/objects/';
const grid = { originals: [], custom: [], page: 1, pages: 1, picked: null, tiles: [], built: false };
const gridBody = document.querySelector('#fighter-grid');
const gridSearch = document.querySelector('#finder-search');
const gridNote = document.querySelector('#finder-page');
function typingTarget(event) { return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement; }
function attachMeta(channel) {
  metaChannel = channel;
  channel.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'roster:begin') { grid.originals = message.originals || []; grid.custom = []; grid.pages = message.pages || 1; grid.page = message.page ?? 1; grid.built = false; }
    else if (message.type === 'roster:chunk') { for (const item of message.items || []) grid.custom.push(item); }
    else if (message.type === 'roster:end') buildGrid();
    else if (message.type === 'roster:page') grid.page = message.page;
    else if (message.type === 'match:ended') showToast(`Player ${message.by} ended the match`);
  };
}
function sendMeta(value) { if (metaChannel?.readyState === 'open') { metaChannel.send(JSON.stringify(value)); return true; } return false; }
function backToGame() { window.scrollTo({ top: 0, behavior: 'smooth' }); document.activeElement?.blur?.(); }
function pickFighter(idx, name) {
  if (!sendMeta({ type: 'roster:pick', idx })) { gridNote.textContent = 'Not connected yet'; return; }
  grid.picked = idx;
  for (const item of grid.tiles) item.el.classList.toggle('picked', item.idx === idx);
  gridNote.textContent = `You picked ${name} for ${slotLabel.textContent}.`;
  backToGame();
}
const portraitUrl = value => !value ? '' : /^[a-f0-9]{64}$/.test(value) ? `${PORTRAIT_BASE}${value}/portrait_medium.png` : (/^https:\/\//.test(value) ? value : '');
function tile(name, sub, idx, imageUrl) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tile${imageUrl ? '' : ' nameonly'}`;
  button.title = `${name}${sub ? ` (${sub})` : ''}`;
  if (imageUrl) { const img = document.createElement('img'); img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.src = imageUrl; button.append(img); }
  const label = document.createElement('span');
  label.textContent = name;
  button.append(label);
  button.addEventListener('click', () => pickFighter(idx, name));
  grid.tiles.push({ el: button, idx, name: name.toLowerCase() });
  return button;
}
function section(title, tiles) {
  const wrap = document.createElement('section');
  const head = document.createElement('h3');
  const body = document.createElement('div');
  body.className = 'tiles';
  body.append(...tiles);
  wrap.append(head, body);
  wrap.update = () => { const shown = tiles.filter(el => !el.hidden).length; head.textContent = `${title} (${shown})`; wrap.hidden = shown === 0; };
  return wrap;
}
// Built once (1058 tiles; portraits load lazily as they scroll into view); search only toggles `hidden`.
function buildGrid() {
  grid.tiles = [];
  const originals = grid.originals.map((name, i) => tile(name, 'original', -1 - TILE_FKINDS[i], ''));
  const custom = grid.custom.map(([name, base, portrait], i) => tile(name, `plays like ${base}`, i, portraitUrl(portrait)));
  grid.sections = [];
  if (originals.length) grid.sections.push(section('Originals', originals));
  if (custom.length) grid.sections.push(section('Custom fighters', custom));
  const empty = document.createElement('p');
  empty.className = 'finder-hint'; empty.id = 'finder-empty'; empty.hidden = true; empty.textContent = 'No fighter matches.';
  gridBody.className = '';
  gridBody.replaceChildren(...grid.sections, empty);
  for (const item of grid.tiles) item.el.classList.toggle('picked', item.idx === grid.picked);
  grid.built = true;
  filterGrid();
}
function filterGrid() {
  const query = gridSearch.value.trim().toLowerCase();
  let shown = 0;
  for (const item of grid.tiles) { const hit = !query || item.name.includes(query); item.el.hidden = !hit; if (hit) shown++; }
  const empty = document.querySelector('#finder-empty');
  for (const wrap of grid.sections || []) wrap.update();
  if (empty) empty.hidden = shown > 0 || !grid.built;
}
gridBody.textContent = 'Fighter list loads when the game connects…';
gridBody.className = 'finder-hint';
gridSearch.addEventListener('input', filterGrid);
gridSearch.addEventListener('keydown', event => { if (event.key === 'Escape') gridSearch.blur(); });

// Play vs CPU: from this guest's own link, start a match alone. The game gives this player a fighter if none is picked, fills the
// ports with no connected guest with CPUs (originals) and starts as if Start was pressed.
document.querySelector('#solo').addEventListener('click', () => {
  const cpus = Number(document.querySelector('#solo-cpus').value);
  if (!sendMeta({ type: 'roster:solo', cpus })) { gridNote.textContent = 'Not connected yet'; return; }
  gridNote.textContent = `Starting a match against ${cpus} CPU${cpus > 1 ? 's' : ''}…`;
  backToGame();
});

// Back to menu: any player can end the running match for everyone after a confirm. The host page passes it to the sidecar and the
// game, which only acts during a match; every guest gets a toast once the game has acknowledged it (otherwise nothing happens).
const endConfirm = document.querySelector('#end-confirm');
const toastEl = document.querySelector('#toast');
let toastTimer = 0;
function showToast(text) { toastEl.textContent = text; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000); }
document.querySelector('#back-to-menu').addEventListener('click', () => { endConfirm.hidden = false; document.querySelector('#end-no').focus(); });
document.querySelector('#end-no').addEventListener('click', () => { endConfirm.hidden = true; });
document.querySelector('#end-yes').addEventListener('click', () => {
  endConfirm.hidden = true;
  if (!sendMeta({ type: 'match:end' })) showToast('Not connected yet');
});
