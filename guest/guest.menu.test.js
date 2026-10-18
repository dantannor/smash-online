import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Page-level checks that need no host or WebRTC: sound defaults, the mute toggle and its persistence, Sharpen being gone, and the
// Back to menu confirm flow (the meta channel is replaced by a recorder through window.__smashGuest.attachMeta).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guestDir = path.join(root, 'guest');

async function serve() {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ port: 2, slotSession: 't' })); return; }
    const file = pathname === '/play' ? path.join(guestDir, 'index.html') : pathname.startsWith('/play/') ? path.join(guestDir, pathname.slice(6)) : path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const data = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(data); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('sound starts on, unlocks on the first gesture, the toggle persists, and Sharpen is gone', { timeout: 40_000 }, async () => {
  const { server, origin } = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/play?room=r&slot=s`);
    await page.waitForFunction(() => window.__smashGuest);
    assert.equal(await page.locator('#sharpen').count(), 0, 'Sharpen button removed');
    assert.equal(await page.locator('#smash-sharpen').count(), 0, 'convolution filter removed');
    assert.equal(await page.locator('#sound').textContent(), 'Sound on');
    assert.deepEqual(await page.evaluate(() => window.__smashGuest.sound), { unlocked: false, muted: false });
    await page.mouse.click(5, 5); // any click on the page unlocks sound
    assert.deepEqual(await page.evaluate(() => window.__smashGuest.sound), { unlocked: true, muted: false });
    await page.locator('#sound').click();
    assert.equal(await page.locator('#sound').textContent(), 'Sound off');
    assert.equal(await page.evaluate(() => localStorage.getItem('smash-muted')), '1');
    await page.reload();
    await page.waitForFunction(() => window.__smashGuest);
    assert.equal(await page.locator('#sound').textContent(), 'Sound off', 'mute survives a reload');
    await page.keyboard.press('KeyJ'); // gestures do not undo an explicit mute
    assert.deepEqual(await page.evaluate(() => window.__smashGuest.sound), { unlocked: true, muted: true });
    await page.locator('#sound').click();
    assert.equal(await page.locator('#sound').textContent(), 'Sound on');
    assert.equal(await page.evaluate(() => localStorage.getItem('smash-muted')), '0');
    await page.reload();
    await page.waitForFunction(() => window.__smashGuest);
    assert.equal(await page.locator('#sound').textContent(), 'Sound on', 'sound on survives a reload');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('Back to menu asks first, sends match:end only on confirm, and toasts when the match was ended', { timeout: 40_000 }, async () => {
  const { server, origin } = await serve();
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/play?room=r&slot=s`);
    await page.waitForFunction(() => window.__smashGuest);
    await page.evaluate(() => {
      window.sent = [];
      window.fakeMeta = { readyState: 'open', send: value => window.sent.push(JSON.parse(value)) };
      window.__smashGuest.attachMeta(window.fakeMeta);
    });
    assert.equal(await page.locator('#back-to-menu').textContent(), 'Back to menu');
    assert.equal(await page.locator('#end-confirm').isHidden(), true);
    await page.locator('#back-to-menu').click();
    assert.equal(await page.locator('#end-confirm').isVisible(), true);
    assert.match(await page.locator('#end-confirm').textContent(), /End this match for everyone\?/);
    assert.deepEqual(await page.evaluate(() => window.sent), [], 'nothing is sent before the confirm');
    await page.locator('#end-no').click();
    assert.equal(await page.locator('#end-confirm').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
    await page.locator('#back-to-menu').click();
    await page.evaluate(() => window.__smashGuest.attachMeta(window.fakeMeta)); // the page has no host and may have reset its channel meanwhile
    await page.locator('#end-yes').click();
    assert.equal(await page.locator('#end-confirm').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'match:end' }]);
    assert.equal(await page.locator('#toast').isHidden(), true, 'no toast until the game acknowledged');
    await page.evaluate(() => window.fakeMeta.onmessage({ data: JSON.stringify({ type: 'match:ended', by: 3 }) }));
    assert.equal(await page.locator('#toast').textContent(), 'Player 3 ended the match');
    assert.equal(await page.locator('#toast').isVisible(), true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
