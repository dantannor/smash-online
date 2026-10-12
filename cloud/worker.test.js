import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8800 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${PORT}`;
let dev;

test.before(async () => {
  execFileSync("node", [join(here, "build-assets.mjs")]);
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", join(here, ".wrangler", `test-${PORT}`)], { cwd: here, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error("wrangler dev did not start");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});
test.after(() => { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* already gone */ } });

const createRoom = async () => (await fetch(`${origin}/api/rooms`, { method: "POST" })).json();
const connect = (query) => new WebSocket(`${origin.replace("http", "ws")}/ws?${new URLSearchParams(query)}`);
const nextMessage = async (ws) => { const [data] = await once(ws, "message"); return JSON.parse(data.toString()); };
const opened = async (ws) => { await once(ws, "open"); return ws; };
const joinSlot = (room, slotToken) => fetch(`${origin}/api/rooms/${room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken }) });

test("health, STUN-only ICE without TURN secrets, static pages, ROM block", async () => {
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: "ok" });
  const ice = await (await fetch(`${origin}/api/ice`)).json();
  assert.deepEqual(ice.iceServers, [{ urls: "stun:stun.cloudflare.com:3478" }]);
  for (const path of ["/host", "/play", "/shared/protocol.js", "/play/guest.js", "/play/input-map.js", "/host/host.js"]) assert.equal((await fetch(`${origin}${path}`)).status, 200, path);
  assert.equal((await fetch(`${origin}/shared/game.z64`)).status, 403);
});

test("rooms, join by slot token, relay, replay and replacement", async () => {
  const room = await createRoom();
  assert.equal(room.slots.length, 3);
  assert.ok(room.slots.every((slot) => slot.guestUrl.startsWith(origin)));
  assert.equal((await joinSlot(room.room, room.slots[1].slotToken)).status, 200);
  assert.equal((await joinSlot(room.room, room.roomToken)).status, 403);
  assert.equal((await joinSlot("missing", room.slots[0].slotToken)).status, 404);

  const guest = await opened(connect({ room: room.room, role: "guest", port: 3, token: room.slots[1].slotToken }));
  const host = connect({ room: room.room, role: "host", token: room.roomToken });
  const replay = await nextMessage(host);
  assert.equal(replay.type, "slot:connected"); assert.equal(replay.port, 3);
  host.send(JSON.stringify({ type: "offer", port: 3, sdp: "o" }));
  assert.deepEqual(await nextMessage(guest), { type: "offer", port: 3, sdp: "o" });
  guest.send(JSON.stringify({ type: "answer", sdp: "a" }));
  assert.deepEqual(await nextMessage(host), { type: "answer", port: 3, sdp: "a" });

  const hostSeen = []; host.on("message", (data) => hostSeen.push(JSON.parse(data.toString())));
  const replaced = nextMessage(guest);
  const second = await opened(connect({ room: room.room, role: "guest", port: 3, token: room.slots[1].slotToken }));
  assert.equal((await replaced).code, "SLOT_REPLACED");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(hostSeen.map((m) => m.type), ["slot:connected"], "replacement announces the new connection and not a disconnect");
  second.close(); await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(hostSeen.map((m) => m.type), ["slot:connected", "slot:disconnected"]);
  host.close();
});

test("API is callable cross-origin from the local host page only", async () => {
  const allowed = await fetch(`${origin}/api/ice`, { headers: { origin: "http://127.0.0.1:8787" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:8787");
  const denied = await fetch(`${origin}/api/ice`, { headers: { origin: "https://evil.example" } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const preflight = await fetch(`${origin}/api/rooms`, { method: "OPTIONS", headers: { origin: "http://localhost:8787", "access-control-request-method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:8787");
});

test("bad credentials and unknown rooms are rejected with a code", async () => {
  const room = await createRoom();
  assert.equal((await nextMessage(connect({ room: "missing", role: "host", token: "x" }))).code, "ROOM_NOT_FOUND");
  assert.equal((await nextMessage(connect({ room: room.room, role: "host", token: "wrong" }))).code, "UNAUTHORIZED");
});

test("p1Guest rooms add a P1 slot that joins and relays; default rooms have no P1", async () => {
  const withP1 = await (await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ p1Guest: true }) })).json();
  assert.deepEqual(withP1.slots.map((s) => s.port), [1, 2, 3, 4]);
  assert.equal((await (await joinSlot(withP1.room, withP1.slots[0].slotToken)).json()).port, 1);
  const guest = await opened(connect({ room: withP1.room, role: "guest", port: 1, token: withP1.slots[0].slotToken }));
  const host = connect({ room: withP1.room, role: "host", token: withP1.roomToken });
  assert.equal((await nextMessage(host)).port, 1);
  host.send(JSON.stringify({ type: "offer", port: 1, sdp: "o" }));
  assert.deepEqual(await nextMessage(guest), { type: "offer", port: 1, sdp: "o" });
  guest.close(); host.close();
  const plain = await createRoom();
  assert.deepEqual(plain.slots.map((s) => s.port), [2, 3, 4]);
  assert.equal((await joinSlot(plain.room, withP1.slots[0].slotToken)).status, 403);
  assert.equal((await nextMessage(connect({ room: plain.room, role: "guest", port: 1, token: withP1.slots[0].slotToken }))).code, "UNAUTHORIZED");
});
