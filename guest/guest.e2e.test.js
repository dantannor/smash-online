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

test('guest plays host video and delivers near-60Hz increasing-sequence input', { timeout: 55_000 }, async () => {
  const peers = new Set();
  let guestSocket;
  let hostSocket;
  const rolesSeen = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/mock-host')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Mock host</title>'); return; }
    if (req.url.startsWith('/api/rooms/')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ port: 2, slotSession: 'test' })); return;
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = pathname === '/play' ? path.join(guestDir, 'index.html') : pathname.startsWith('/play/') ? path.join(guestDir, pathname.slice('/play/'.length)) : path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const data = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(data); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (socket, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    rolesSeen.push(role);
    peers.add(socket);
    if (role === 'host') hostSocket = socket;
    if (role === 'guest') { guestSocket = socket; if (hostSocket?.readyState === 1) hostSocket.send(JSON.stringify({ type: 'make-offer' })); }
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'make-offer') return;
      const destination = role === 'host' ? guestSocket : hostSocket;
      if (destination?.readyState === 1) destination.send(JSON.stringify(message));
    });
    socket.on('close', () => peers.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const host = await browser.newPage();
    await host.goto(`${origin}/mock-host`);
    await host.evaluate(({ origin }) => {
      window.received = [];
      const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?room=test&role=host&token=host-token');
      window.hostReadyState = 'connecting';
      window.hostReady = new Promise(resolve => { ws.onopen = () => { window.hostReadyState = 'open'; resolve(); }; ws.onerror = () => { window.hostReadyState = 'error'; resolve(); }; });
      let pc;
      ws.onmessage = async event => {
        const message = JSON.parse(event.data);
        window.hostLastMessage = message.type;
        if (message.type === 'make-offer') {
          pc = new RTCPeerConnection({ iceServers: [] });
          const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
          const ctx = canvas.getContext('2d'); let frame = 0;
          setInterval(() => { ctx.fillStyle = `rgb(${frame++ % 255},20,40)`; ctx.fillRect(0, 0, 320, 180); }, 16);
          const stream = canvas.captureStream(30);
          pc.addTrack(stream.getVideoTracks()[0], stream);
          const channel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
          channel.onmessage = e => window.received.push(JSON.parse(e.data));
          pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
        }
        if (message.type === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        if (message.type === 'ice' && pc) { try { await pc.addIceCandidate(message.candidate); } catch {} }
      };
    }, { origin });
    try { await host.waitForFunction(() => window.hostReadyState === 'open', undefined, { timeout: 5000 }); }
    catch (error) { throw new Error(`${error.message}; host=${JSON.stringify(await host.evaluate(() => ({ state: window.hostReadyState, url: location.href })))}; roles=${JSON.stringify(rolesSeen)}`); }
    const guest = await browser.newPage();
    await guest.goto(`${origin}/play?room=test-room&slot=test-slot`);
    try { await guest.waitForFunction(() => document.querySelector('#video').videoWidth > 0 && document.querySelector('#video').currentTime > 0, undefined, { timeout: 8000 }); }
    catch (error) { throw new Error(`${error.message}; guest=${JSON.stringify(await guest.evaluate(() => ({ state: window.__smashGuest?.stats(), html: document.querySelector('#hint')?.textContent, video: { width: document.querySelector('#video').videoWidth, error: document.querySelector('#video').error?.message } })))}; hostMessage=${await host.evaluate(() => window.hostLastMessage)}; roles=${JSON.stringify(rolesSeen)}; hostState=${hostSocket?.readyState}`); }
    try { await guest.waitForFunction(() => window.__smashGuest?.state.connection === 'Connected', undefined, { timeout: 8000 }); }
    catch (error) { throw new Error(`${error.message}; guest=${JSON.stringify(await guest.evaluate(() => ({ state: window.__smashGuest?.stats(), hint: document.querySelector('#hint')?.textContent })))}`); }
    await guest.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0x8000, sx: 22, sy: -17 }));
    await host.waitForFunction(() => window.received.filter(sample => sample.buttons === 0x8000 && sample.sx === 22 && sample.sy === -17).length >= 12, undefined, { timeout: 12000 });
    const samples = await host.evaluate(() => window.received.filter(sample => sample.buttons === 0x8000 && sample.sx === 22 && sample.sy === -17).slice(-12));
    assert.ok(samples.length >= 8);
    assert.ok(samples.every((sample, index) => Number.isInteger(sample.seq) && sample.buttons === 0x8000 && sample.sx === 22 && sample.sy === -17));
    for (let i = 1; i < samples.length; i++) assert.equal((samples[i].seq - samples[i - 1].seq) >>> 0, 1);
    const elapsed = samples.at(-1).t - samples[0].t;
    assert.ok(elapsed >= 80 && elapsed <= 1200, `sample span ${elapsed}ms should be consistent with approximately 60Hz`);
    assert.equal(await guest.evaluate(() => document.querySelector('#video').muted), true);
  } finally {
    await browser?.close();
    for (const socket of peers) socket.close();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  }
});
