import { Room } from "./room.js";
export { Room };

const PORTS = [2, 3, 4];
const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];
const ROM_EXT = /\.(n64|z64|v64|o2r|otr)$/i;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const randomToken = (bytes) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const hashHex = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
    });
    if (!response.ok) return STUN;
    const { iceServers: turn } = await response.json();
    return Array.isArray(turn) && turn.length ? [...STUN, ...turn.filter((server) => !String(server.urls).startsWith("stun:"))] : STUN;
  } catch { return STUN; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json(200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/api/ice") return json(200, { iceServers: await iceServers(env) });
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const id = randomToken(12);
      const roomToken = randomToken(32);
      const slotTokens = Object.fromEntries(PORTS.map((port) => [port, randomToken(32)]));
      const slotTokenHashes = Object.fromEntries(await Promise.all(PORTS.map(async (port) => [port, await hashHex(slotTokens[port])])));
      await roomStub(env, id).init({ roomTokenHash: await hashHex(roomToken), slotTokenHashes });
      const origin = url.origin;
      return json(201, { room: id, roomToken, hostUrl: `${origin}/host?room=${encodeURIComponent(id)}`, slots: PORTS.map((port) => ({ port, slotToken: slotTokens[port], guestUrl: `${origin}/play?room=${encodeURIComponent(id)}&slot=${encodeURIComponent(slotTokens[port])}` })) });
    }
    const joinMatch = request.method === "POST" && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/join$/);
    if (joinMatch) {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: { code: "BAD_REQUEST", message: "Expected a JSON body" } }); }
      const result = await roomStub(env, joinMatch[1]).join(body?.slotToken);
      if (result.error === "ROOM_NOT_FOUND") return json(404, { error: { code: "ROOM_NOT_FOUND", message: "Room not found or expired" } });
      if (result.error) return json(403, { error: { code: "UNAUTHORIZED", message: "Invalid slot token" } });
      return json(200, { port: result.port, slotSession: randomToken(32) });
    }
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      if (!room || !/^[A-Za-z0-9_-]+$/.test(room) || request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      return roomStub(env, room).fetch(request);
    }
    if (ROM_EXT.test(url.pathname)) return json(403, { error: { code: "ROM_FORBIDDEN", message: "ROM files are not served" } });
    return env.ASSETS.fetch(request);
  },
};
