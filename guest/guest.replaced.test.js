import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { createApplication } from "../server/index.js";

test("a guest tab replaced by another client stops reconnecting and says why", { timeout: 40_000 }, async (t) => {
  const app = createApplication();
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const room = await (await fetch(`${origin}/api/rooms`, { method: "POST" })).json();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage();
  await page.goto(room.slots[0].guestUrl.replace(/^https?:\/\/[^/]+/, origin));
  await page.waitForFunction(() => window.__smashGuest.state.connection === "Signaling connected");
  const intruder = new WebSocket(`${origin.replace("http", "ws")}/ws?${new URLSearchParams({ room: room.room, role: "guest", port: 2, token: room.slots[0].slotToken })}`);
  await once(intruder, "open");
  await page.waitForFunction(() => window.__smashGuest.state.connection === "Replaced");
  const joinsBefore = [...app.wss.clients].length;
  await page.waitForTimeout(2500);
  assert.equal([...app.wss.clients].length, joinsBefore, "replaced tab does not reconnect");
  assert.match(await page.locator("#connection").textContent(), /another tab/);
  intruder.close();
});
