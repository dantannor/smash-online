import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApplication } from "./index.js";

async function setup(options) {
  const app = createApplication(options);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return { app, origin, close: () => app.close() };
}
async function createRoom(origin, headers = {}) {
  const response = await fetch(`${origin}/api/rooms`, { method: "POST", headers });
  assert.equal(response.status, 201);
  return response.json();
}
function connect(origin, query) { return new WebSocket(`${origin.replace("http", "ws")}/ws?${new URLSearchParams(query)}`); }
async function opened(ws) { await once(ws, "open"); return ws; }
async function nextMessage(ws) { const [data] = await once(ws, "message"); return JSON.parse(data.toString()); }
async function closeSocket(ws) { if (ws.readyState === WebSocket.CLOSED) return; ws.close(); await once(ws, "close"); }

test("creates 256-bit room and independent slot tokens, joins by slot token", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  assert.equal(room.slots.length, 3);
  assert.ok(room.roomToken.length >= 43);
  assert.equal(new Set(room.slots.map((s) => s.slotToken)).size, 3);
  assert.ok(room.slots.every((s) => s.slotToken.length >= 43));
  assert.equal((await fetch(`${ctx.origin}/api/rooms/${room.room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken: room.slots[1].slotToken }) })).status, 200);
  assert.equal((await fetch(`${ctx.origin}/api/rooms/${room.room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken: room.roomToken }) })).status, 403);
});

test("uses forwarded public origin and exposes STUN-only ICE", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin, { "x-forwarded-proto": "https", "x-forwarded-host": "game.example.test" });
  assert.match(room.hostUrl, /^https:\/\/game\.example\.test\/host/);
  assert.ok(room.slots.every((slot) => slot.guestUrl.startsWith("https://game.example.test/play")));
  const ice = await (await fetch(`${ctx.origin}/api/ice`)).json();
  assert.ok(ice.iceServers.length >= 2);
  assert.ok(ice.iceServers.every((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).every((url) => url.startsWith("stun:"))));
});

test("relays host offer, guest answer and ICE only to the authenticated peers", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  const host = await opened(connect(ctx.origin, { room: room.room, role: "host", token: room.roomToken }));
  const guest = await opened(connect(ctx.origin, { room: room.room, role: "guest", token: room.slots[0].slotToken, port: "2" }));
  const connected = await nextMessage(host);
  assert.equal(connected.type, "slot:connected"); assert.equal(connected.port, 2);
  host.send(JSON.stringify({ type: "offer", port: 2, sdp: "offer" }));
  assert.deepEqual(await nextMessage(guest), { type: "offer", port: 2, sdp: "offer" });
  guest.send(JSON.stringify({ type: "answer", sdp: "answer" }));
  assert.deepEqual(await nextMessage(host), { type: "answer", port: 2, sdp: "answer" });
  guest.send(JSON.stringify({ type: "ice", candidate: { candidate: "candidate" } }));
  assert.deepEqual(await nextMessage(host), { type: "ice", port: 2, candidate: { candidate: "candidate" } });
  await closeSocket(guest); assert.equal((await nextMessage(host)).type, "slot:disconnected");
  await closeSocket(host);
});

test("replacing a guest prevents the old close from disconnecting the new connection", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  const host = await opened(connect(ctx.origin, { room: room.room, role: "host", token: room.roomToken }));
  const old = await opened(connect(ctx.origin, { room: room.room, role: "guest", token: room.slots[0].slotToken, port: "2" }));
  const connected1 = await nextMessage(host);
  const replacement = await opened(connect(ctx.origin, { room: room.room, role: "guest", token: room.slots[0].slotToken, port: "2" }));
  const connected2 = await nextMessage(host);
  assert.notEqual(connected1.connectionId, connected2.connectionId);
  await once(old, "close");
  replacement.send(JSON.stringify({ type: "answer", sdp: "still-live" }));
  assert.deepEqual(await nextMessage(host), { type: "answer", port: 2, sdp: "still-live" });
  await closeSocket(replacement); assert.equal((await nextMessage(host)).type, "slot:disconnected");
  await closeSocket(host);
});

test("expires rooms after 30 minutes of inactivity", async (t) => {
  let time = 1000;
  const ctx = await setup({ now: () => time }); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  time += 30 * 60 * 1000;
  const response = await fetch(`${ctx.origin}/api/rooms/${room.room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken: room.slots[0].slotToken }) });
  assert.equal(response.status, 404);
});

test("keeps a room alive while any socket is connected", async (t) => {
  let time = 1000;
  const ctx = await setup({ now: () => time }); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  const host = await opened(connect(ctx.origin, { room: room.room, role: "host", token: room.roomToken }));
  time += 2 * 60 * 60 * 1000;
  const join = () => fetch(`${ctx.origin}/api/rooms/${room.room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken: room.slots[0].slotToken }) });
  assert.equal((await join()).status, 200);
  await closeSocket(host);
  time += 30 * 60 * 1000;
  assert.equal((await join()).status, 404);
});

test("tells an expired-room websocket the room is gone", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const host = connect(ctx.origin, { room: "missing", role: "host", token: "x" });
  assert.equal((await nextMessage(host)).code, "ROOM_NOT_FOUND");
});

test("replays already-connected guests to a host that connects later", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  const guest = await opened(connect(ctx.origin, { room: room.room, role: "guest", port: 3, token: room.slots[1].slotToken }));
  const host = connect(ctx.origin, { room: room.room, role: "host", token: room.roomToken });
  const replayed = await nextMessage(host);
  assert.equal(replayed.type, "slot:connected"); assert.equal(replayed.port, 3);
  assert.ok(replayed.connectionId);
  await closeSocket(guest); await closeSocket(host);
});

test("serves static pages safely and blocks ROMs and traversal", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const host = await fetch(`${ctx.origin}/host`); assert.equal(host.status, 200); assert.match(host.headers.get("cache-control"), /no-cache/);
  assert.equal((await fetch(`${ctx.origin}/shared/protocol.js`)).status, 200);
  assert.equal((await fetch(`${ctx.origin}/play/guest.js`)).status, 200);
  assert.equal((await fetch(`${ctx.origin}/play/input-map.js`)).status, 200);
  assert.equal((await fetch(`${ctx.origin}/guest/guest.js`)).status, 404);
  assert.equal((await fetch(`${ctx.origin}/shared/%2e%2e%2fPROTOCOL.md`)).status, 403);
  for (const file of ["game.n64", "game.z64", "game.v64", "game.o2r", "game.otr"]) assert.equal((await fetch(`${ctx.origin}/shared/${file}`)).status, 403);
});

test("tells a replaced guest socket why it was closed", async (t) => {
  const ctx = await setup(); t.after(ctx.close);
  const room = await createRoom(ctx.origin);
  const query = { room: room.room, role: "guest", port: 2, token: room.slots[0].slotToken };
  const first = await opened(connect(ctx.origin, query));
  const message = nextMessage(first);
  const second = await opened(connect(ctx.origin, query));
  assert.equal((await message).code, "SLOT_REPLACED");
  await closeSocket(second);
});
