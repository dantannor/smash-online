// Black-video regression: with autoplay restricted, one click on "Sound on" must leave a visible, playing, letterboxed picture
// in every browser and viewport (wide-short laptop window, normal laptop, phone landscape), and after a stream replacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium, webkit, firefox } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guestDir = path.join(root, 'guest');
const shots = process.env.SMASH_SHOTS_DIR;
const VIEWPORTS = [[1280, 617], [1440, 900], [844, 390], [1920, 600], [2560, 1080]];
const BROWSERS = {
  chromium: () => chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required', '--mute-audio'] }),
  webkit: () => webkit.launch({ headless: true }),
  firefox: () => firefox.launch({ headless: true, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }),
};

async function startServer() {
  const sockets = { host: null, guest: null };
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/mock-host') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>host</title>'); return; }
    if (pathname === '/api/ice') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"iceServers":[]}'); return; }
    if (pathname.startsWith('/api/rooms/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ port: 2 })); return; }
    const file = pathname === '/play' ? path.join(guestDir, 'index.html') : pathname.startsWith('/play/') ? path.join(guestDir, pathname.slice(6)) : path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const data = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(data); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
  wss.on('connection', (socket, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    sockets[role] = socket;
    if (role === 'guest' && sockets.host?.readyState === 1) sockets.host.send(JSON.stringify({ type: 'make-offer' }));
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      const destination = role === 'host' ? sockets.guest : sockets.host;
      if (message.type !== 'make-offer' && destination?.readyState === 1) destination.send(JSON.stringify(message));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { sockets, origin: `http://127.0.0.1:${server.address().port}`, close: async () => { for (const s of wss.clients) s.close(); wss.close(); await new Promise(resolve => server.close(resolve)); } };
}

async function startHost(browser, origin) {
  const host = await browser.newPage();
  await host.goto(`${origin}/mock-host`);
  await host.evaluate(({ origin }) => {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?room=t&role=host&token=h');
    window.hostOpen = new Promise(resolve => { ws.onopen = resolve; });
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d'); let frame = 0;
    setInterval(() => { // bright moving 4:3 test card with a visible border, never black
      ctx.fillStyle = '#2a7bd6'; ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#f2c230'; ctx.fillRect(20 + (frame * 4) % 500, 100, 100, 280);
      ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, 640, 12); ctx.fillRect(0, 468, 640, 12); frame++;
    }, 16);
    let pc;
    ws.onmessage = async event => {
      const message = JSON.parse(event.data);
      if (message.type === 'make-offer') {
        pc?.close();
        pc = new RTCPeerConnection({ iceServers: [] });
        const stream = canvas.captureStream(30);
        pc.addTrack(stream.getVideoTracks()[0], stream);
        pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
        pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
        await pc.setLocalDescription(await pc.createOffer());
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      }
      if (message.type === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      if (message.type === 'ice' && pc) { try { await pc.addIceCandidate(message.candidate); } catch { /* stale */ } }
    };
  }, { origin });
  await host.evaluate(() => window.hostOpen);
  return host;
}

// Brightness of the video area as the user sees it: screenshot -> decode in the page -> mean luma of the central region.
async function visibleLuma(page, name) {
  const png = await page.locator('#screen').screenshot();
  if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); }
  return page.evaluate(async b64 => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(Math.floor(c.width * 0.25), Math.floor(c.height * 0.25), Math.floor(c.width * 0.5), Math.floor(c.height * 0.5));
    let sum = 0; for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    return sum / (data.length / 4);
  }, png.toString('base64'));
}
async function assertVisiblyPlaying(page, label) {
  await page.waitForFunction(() => { const v = document.querySelector('#video'); return !v.paused && v.videoWidth > 0 && v.currentTime > 0; }, undefined, { timeout: 15000 })
    .catch(async error => { throw new Error(`${label}: ${error.message}; ${JSON.stringify(await page.evaluate(() => { const v = document.querySelector('#video'); return { paused: v.paused, t: v.currentTime, w: v.videoWidth, rs: v.readyState, hint: document.querySelector('#hint').textContent, hidden: document.querySelector('#hint').hidden }; }))}`); });
  const t0 = await page.evaluate(() => document.querySelector('#video').currentTime);
  await page.waitForFunction(t => document.querySelector('#video').currentTime > t + 0.3, t0, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.querySelector('#hint').hidden), true, `${label}: banner hidden once playing`);
  const box = await page.evaluate(() => { const r = document.querySelector('#video').getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
  assert.ok(box.w > 100 && box.h > 100 && box.w <= box.vw && box.h <= box.vh, `${label}: video box ${JSON.stringify(box)}`);
  assert.equal(await page.evaluate(() => document.querySelector('#video').muted), true, `${label}: video element stays muted`);
}

for (const [name, launch] of Object.entries(BROWSERS)) {
  const exe = { chromium, webkit, firefox }[name].executablePath();
  test(`guest video plays and is visible after only "Sound on" is clicked (${name})`, { skip: !existsSync(exe) && `${name} not installed`, timeout: 170_000 }, async () => {
    const app = await startServer();
    const hostBrowser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    const browser = await launch();
    try {
      const host = await startHost(hostBrowser, app.origin);
      for (const [width, height] of VIEWPORTS) {
        const label = `${name} ${width}x${height}`;
        const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: false });
        const page = await context.newPage();
        await page.goto(`${app.origin}/play?room=r&slot=s`);
        await page.waitForFunction(() => window.__smashGuest?.state.connection === 'Connected', undefined, { timeout: 15000 })
          .catch(async error => { throw new Error(`${label} not connected: ${error.message} ${await page.evaluate(() => JSON.stringify(window.__smashGuest?.state))}`); });
        await page.locator('#sound').click();
        assert.equal(await page.locator('#sound').textContent(), 'Sound on');
        await assertVisiblyPlaying(page, label);
        const box = await page.evaluate(() => { const r = document.querySelector('#video').getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; });
        const luma = await visibleLuma(page, label.replace(' ', '-'));
        assert.ok(luma > 40, `${label}: video area is black (mean luma ${luma}, element ${box})`);
        if (width === 1280) { // stream replacement: the host drops the guest's peer; the new stream must be attached and play again
          const before = await page.evaluate(() => document.querySelector('#video').srcObject?.id);
          app.sockets.guest.close();
          await page.waitForFunction(id => { const v = document.querySelector('#video'); return v.srcObject && v.srcObject.id !== id && !v.paused && v.currentTime > 0.2; }, before, { timeout: 20000 });
          await assertVisiblyPlaying(page, `${label} after replacement`);
          assert.ok(await visibleLuma(page, `${label.replace(' ', '-')}-replaced`) > 40, `${label}: black after replacement`);
        }
        await context.close();
      }
      await host.close();
    } finally { await browser.close(); await hostBrowser.close(); await app.close(); }
  });
}
