import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guestDir = path.join(root, 'guest');

test('relayed synthetic PCM reaches the guest as active inbound audio RTP', { timeout: 55_000 }, async () => {
  const hostPeers = new Set();
  const relayPeers = new Set();
  let hostSignal;
  let guestSignal;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/rooms/')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ port: 2, slotSession: 'test' })); return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const files = {
      '/play': path.join(guestDir, 'index.html'),
      '/play/guest.js': path.join(guestDir, 'guest.js'),
      '/play/input-map.js': path.join(guestDir, 'input-map.js'),
      '/shared/protocol.js': path.join(root, 'shared/protocol.js'),
      '/host/audio-worklet.js': path.join(root, 'host/audio-worklet.js'),
      '/mock-host': null,
    };
    if (pathname === '/mock-host') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><script>
        const signal = window.signal = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?role=host');
        const relay = window.relay = new WebSocket(location.origin.replace(/^http/, 'ws') + '/audio?role=host');
        relay.binaryType = 'arraybuffer';
        const context = new AudioContext({ sampleRate: 48000 });
        let destination, node, pc;
        Promise.all([context.audioWorklet.addModule('/host/audio-worklet.js'), new Promise(resolve => relay.addEventListener('open', resolve))]).then(async () => {
          node = new AudioWorkletNode(context, 'smash-pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          destination = context.createMediaStreamDestination(); node.connect(destination); await context.resume();
        });
        signal.onmessage = async ({ data }) => {
          if (JSON.parse(data).type !== 'make-offer') return;
          pc = window.pc = new RTCPeerConnection({ iceServers: [] });
          const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
          const ctx = canvas.getContext('2d'); ctx.fillRect(0, 0, 320, 180);
          const video = canvas.captureStream(30); pc.addTrack(video.getVideoTracks()[0], video);
          pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
          await new Promise(resolve => { const check = () => destination ? resolve() : setTimeout(check, 10); check(); });
          pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
          pc.onicecandidate = e => { if (e.candidate) signal.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer); signal.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
        };
        signal.addEventListener('message', async ({ data }) => {
          const m = JSON.parse(data);
          if (m.type === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          if (m.type === 'ice' && pc) { try { await pc.addIceCandidate(m.candidate); } catch {} }
        });
        relay.onmessage = ({ data }) => { if (node) node.port.postMessage(new Float32Array(data), [data]); };
      </script>`);
      return;
    }
    const file = files[pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    try { const data = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(data); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  const signalWss = new WebSocketServer({ noServer: true });
  const relayWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const target = pathname === '/ws' ? signalWss : pathname === '/audio' ? relayWss : null;
    if (!target) return socket.destroy();
    target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
  });
  signalWss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    if (role === 'host') hostSignal = ws;
    else {
      guestSignal = ws;
      setTimeout(() => { if (hostSignal?.readyState === 1) hostSignal.send(JSON.stringify({ type: 'make-offer' })); }, 10);
    }
    ws.on('message', data => {
      const destination = role === 'host' ? guestSignal : hostSignal;
      if (destination?.readyState === 1) destination.send(data.toString());
    });
    ws.on('close', () => { if (role === 'host' && hostSignal === ws) hostSignal = null; if (role === 'guest' && guestSignal === ws) guestSignal = null; });
  });
  relayWss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    relayPeers.add(ws);
    ws.on('message', (data, isBinary) => {
      if (role !== 'audio' || !isBinary || data.length === 0 || data.length % 8 !== 0) return;
      for (const target of relayPeers) if (target !== ws && target.readyState === 1) target.send(data, { binary: true });
    });
    ws.on('close', () => relayPeers.delete(ws));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let sourceTimer;
  let source;
  try {
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const host = await browser.newPage();
    host.on('pageerror', error => console.error('[audio-test host]', error));
    await host.goto(`${origin}/mock-host`);
    await host.waitForFunction(() => window.signal?.readyState === WebSocket.OPEN && window.relay?.readyState === WebSocket.OPEN, undefined, { timeout: 5000 });
    source = new (await import('ws')).default(`${origin.replace('http', 'ws')}/audio?role=audio`);
    await new Promise((resolve, reject) => { source.once('open', resolve); source.once('error', reject); });
    let phase = 0;
    const samples = new Float32Array(480 * 2);
    sourceTimer = setInterval(() => {
      for (let i = 0; i < 480; i++) { const v = Math.sin(2 * Math.PI * 440 * (phase++ / 48000)) * 0.25; samples[i * 2] = v; samples[i * 2 + 1] = v; }
      source.send(Buffer.from(samples.buffer));
    }, 10);
    const guest = await browser.newPage();
    guest.on('pageerror', error => console.error('[audio-test guest]', error));
    await guest.goto(`${origin}/play?room=test-room&slot=test-slot`);
    try { await guest.waitForFunction(() => window.__smashGuest?.state.connection === 'Connected', undefined, { timeout: 15000 }); }
    catch (error) { throw new Error(`${error.message}; guest=${JSON.stringify(await guest.evaluate(() => window.__smashGuest?.stats()))}; host=${JSON.stringify(await host.evaluate(() => ({ signal: window.signal?.readyState, relay: window.relay?.readyState, pc: window.pc?.connectionState, pcSignal: window.pc?.signalingState, signaling: window.signal?.readyState })))}`); }
    const audioStats = await guest.evaluate(async () => {
      const reports = await window.__smashGuest.stats();
      return reports.rtcStats.filter(item => item.kind === 'audio').map(item => ({ type: item.type, keys: Object.keys(item), audioLevel: item.audioLevel, totalSamplesReceived: item.totalSamplesReceived, packetsReceived: item.packetsReceived, bytesReceived: item.bytesReceived, totalSamplesCount: item.totalSamplesCount, totalSamplesDuration: item.totalSamplesDuration }));
    });
    const playout = audioStats.find(item => item.type === 'media-playout');
    assert.ok(playout && playout.totalSamplesCount > 0, JSON.stringify(audioStats));
  } finally {
    clearInterval(sourceTimer);
    source?.close();
    await browser?.close();
    for (const ws of [...hostPeers, ...relayPeers]) ws.close();
    signalWss.close(); relayWss.close();
    await new Promise(resolve => server.close(resolve));
  }
});
