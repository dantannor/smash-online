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
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", join(here, ".wrangler", `test-${PORT}`)], { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 40_000;
  for (;;) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error("wrangler dev did not start");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});
test.after(() => { dev?.kill("SIGTERM"); });

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

test("bad credentials and unknown rooms are rejected with a code", async () => {
  const room = await createRoom();
  assert.equal((await nextMessage(connect({ room: "missing", role: "host", token: "x" }))).code, "ROOM_NOT_FOUND");
  assert.equal((await nextMessage(connect({ room: room.room, role: "host", token: "wrong" }))).code, "UNAUTHORIZED");
});
