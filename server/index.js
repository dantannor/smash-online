import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TTL_MS = 30 * 60 * 1000;
const PORTS = [2, 3, 4];
const STUN = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8" };
const ROM_EXT = new Set([".n64", ".z64", ".v64", ".o2r", ".otr"]);
const DEBUG_WS = process.env.SMASH_DEBUG === "1";
const hash = (token) => createHash("sha256").update(token).digest();
const token = () => randomBytes(32).toString("base64url");
const json = (res, status, data) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };

export function createApplication({ now = Date.now } = {}) {
  const rooms = new Map();
  const connections = new WeakMap();
  function sweep() {
    const time = now();
    for (const [id, room] of rooms) if (time - room.lastActivity >= TTL_MS) {
      for (const socket of [room.host, ...Object.values(room.slots).map((slot) => slot.socket)]) if (socket?.readyState === WebSocket.OPEN) socket.close(1001, "room expired");
      rooms.delete(id);
    }
  }
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && url.pathname === "/api/ice") return json(res, 200, { iceServers: STUN.map((urls) => ({ urls })) });
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      sweep();
      const id = randomBytes(12).toString("base64url");
      const roomToken = token();
      const slots = Object.fromEntries(PORTS.map((port) => [port, { tokenHash: hash(token()), socket: null, connectionId: null }]));
      const slotTokens = Object.fromEntries(PORTS.map((port) => [port, null]));
      for (const port of PORTS) slotTokens[port] = token();
      for (const port of PORTS) slots[port].tokenHash = hash(slotTokens[port]);
      const room = { id, tokenHash: hash(roomToken), slots, host: null, lastActivity: now() };
      rooms.set(id, room);
      const origin = forwardedOrigin(req);
      return json(res, 201, { room: id, roomToken, hostUrl: `${origin}/host?room=${encodeURIComponent(id)}`, slots: PORTS.map((port) => ({ port, slotToken: slotTokens[port], guestUrl: `${origin}/play?room=${encodeURIComponent(id)}&slot=${encodeURIComponent(slotTokens[port])}` })) });
    }
    const joinMatch = req.method === "POST" && url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/join$/);
    if (joinMatch) {
      sweep(); const room = rooms.get(joinMatch[1]);
      if (!room) return json(res, 404, { error: { code: "ROOM_NOT_FOUND", message: "Room not found or expired" } });
      try {
        const body = await readJson(req);
        const supplied = typeof body.slotToken === "string" ? hash(body.slotToken) : Buffer.alloc(32);
        const port = PORTS.find((p) => timingSafeEqual(room.slots[p].tokenHash, supplied));
        if (!port) return json(res, 403, { error: { code: "UNAUTHORIZED", message: "Invalid slot token" } });
        room.lastActivity = now();
        return json(res, 200, { port, slotSession: token() });
      } catch { return json(res, 400, { error: { code: "BAD_REQUEST", message: "Expected a JSON body" } }); }
    }
    return serveStatic(req, res, url.pathname);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, url));
  });
  wss.on("connection", (ws, req, url) => {
    sweep();
    const room = rooms.get(url.searchParams.get("room"));
    const role = url.searchParams.get("role");
    const supplied = url.searchParams.get("token") || "";
    let port = Number(url.searchParams.get("port"));
    ws.smashMeta = { role, port: Number.isFinite(port) && port > 0 ? port : null, room: room?.id ?? null, connectionId: null };
    let authorized = false;
    if (room && role === "host") authorized = equal(room.tokenHash, hash(supplied));
    if (room && role === "guest" && PORTS.includes(port)) authorized = equal(room.slots[port].tokenHash, hash(supplied));
    if (!authorized) { sendError(ws, "UNAUTHORIZED", "Invalid room credentials"); ws.close(1008, "unauthorized"); return; }
    room.lastActivity = now();
    let connectionId;
    if (role === "host") {
      if (room.host?.readyState === WebSocket.OPEN) room.host.close(4001, "host replaced");
      room.host = ws;
    } else {
      const slot = room.slots[port];
      if (slot.socket?.readyState === WebSocket.OPEN) slot.socket.close(4001, "slot replaced");
      connectionId = randomBytes(12).toString("base64url"); slot.socket = ws; slot.connectionId = connectionId;
      ws.smashMeta.connectionId = connectionId;
      if (room.host?.readyState === WebSocket.OPEN) send(room.host, { type: "slot:connected", port, connectionId });
    }
    const meta = { room, role, port, connectionId };
    connections.set(ws, meta);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendError(ws, "BAD_MESSAGE", "Messages must be JSON text");
      let message;
      try { message = JSON.parse(data.toString()); } catch { debugWs("in", ws, { type: "invalid_json" }); return sendError(ws, "BAD_MESSAGE", "Invalid JSON envelope"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) { debugWs("in", ws, { type: "invalid_envelope" }); return sendError(ws, "BAD_MESSAGE", "Expected a JSON envelope"); }
      const { type } = message;
      debugWs("in", ws, message);
      if (role === "host" && type === "offer") {
        if (!PORTS.includes(message.port) || typeof message.sdp !== "string" || message.sdp.length > 900_000) return sendError(ws, "BAD_MESSAGE", "Invalid offer");
        relay(room.slots[message.port].socket, { type, port: message.port, sdp: message.sdp });
      } else if (role === "guest" && type === "answer") {
        if (typeof message.sdp !== "string" || message.sdp.length > 900_000) return sendError(ws, "BAD_MESSAGE", "Invalid answer");
        relay(room.host, { type, port, sdp: message.sdp });
      } else if ((role === "host" || role === "guest") && type === "ice") {
        if (!Object.hasOwn(message, "candidate") || JSON.stringify(message.candidate).length > 100_000) return sendError(ws, "BAD_MESSAGE", "Invalid ICE candidate");
        const target = role === "host" ? room.slots[message.port]?.socket : room.host;
        if (role === "host" && !PORTS.includes(message.port)) return sendError(ws, "BAD_MESSAGE", "Invalid port");
        relay(target, { type, ...(role === "guest" ? { port } : { port: message.port }), candidate: message.candidate });
      } else sendError(ws, "INVALID_OPERATION", "Message type is not allowed for this role");
      room.lastActivity = now();
    });
    ws.on("close", () => {
      if (role === "host") { if (room.host === ws) room.host = null; return; }
      const slot = room.slots[port];
      if (slot.socket !== ws || slot.connectionId !== connectionId) return;
      slot.socket = null; slot.connectionId = null;
      if (room.host?.readyState === WebSocket.OPEN) send(room.host, { type: "slot:disconnected", port, connectionId });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 25_000);
  wss.on("connection", (ws) => { ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; }); });
  server.on("close", () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.close(); });
  return { server, wss, rooms, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

function equal(expected, actual) { return expected.length === actual.length && timingSafeEqual(expected, actual); }
function send(ws, data) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  debugWs("out", ws, data);
  ws.send(JSON.stringify(data));
}
function debugWs(direction, ws, message) {
  if (!DEBUG_WS) return;
  const meta = ws?.smashMeta ?? {};
  console.log(JSON.stringify({ event: "ws", direction, role: meta.role ?? "unknown", port: message.port ?? meta.port ?? null, connectionId: message.connectionId ?? meta.connectionId ?? null, type: typeof message.type === "string" ? message.type : "unknown" }));
}
function sendError(ws, code, message) { send(ws, { type: "error", code, message }); }
function relay(ws, message) { if (ws?.readyState === WebSocket.OPEN) send(ws, message); }
function forwardedOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").toString().split(",")[0].trim();
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
function readJson(req) { return new Promise((resolveBody, reject) => { let body = ""; req.setEncoding("utf8"); req.on("data", (part) => { body += part; if (body.length > 16_384) reject(new Error("too large")); }); req.on("end", () => { try { resolveBody(JSON.parse(body || "{}")); } catch (error) { reject(error); } }); req.on("error", reject); }); }
function safeFile(base, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === "..")) return null;
  const file = resolve(base, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (file !== base && !file.startsWith(`${base}${sep}`)) return null;
  return file;
}
function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
  if (pathname.split("/").some((part) => { try { return ROM_EXT.has(extname(decodeURIComponent(part)).toLowerCase()); } catch { return true; } })) return json(res, 403, { error: { code: "ROM_FORBIDDEN", message: "ROM files are not served" } });
  let base, relative;
  if (pathname === "/host" || pathname.startsWith("/host/")) { base = resolve(ROOT, "host"); relative = pathname === "/host" || pathname === "/host/" ? "/index.html" : pathname.slice(5); }
  else if (pathname === "/play" || pathname.startsWith("/play/")) { base = resolve(ROOT, "guest"); relative = pathname === "/play" || pathname === "/play/" ? "/index.html" : pathname.slice(5); }
  else if (pathname.startsWith("/shared/")) { base = resolve(ROOT, "shared"); relative = pathname.slice(7); }
  else return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  const file = safeFile(base, relative);
  if (!file) return json(res, 403, { error: { code: "PATH_FORBIDDEN", message: "Invalid path" } });
  let selected = file;
  if (!existsSync(selected) && ["/host", "/host/", "/play", "/play/"].includes(pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end("<!doctype html><meta charset=utf-8><title>Smash Online</title><p>Client is not available yet.</p>");
  }
  try { if (!statSync(selected).isFile()) return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } }); } catch { return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } }); }
  const headers = { "content-type": MIME[extname(selected).toLowerCase()] || "application/octet-stream", "content-length": statSync(selected).size };
  if (extname(selected).toLowerCase() === ".html") headers["cache-control"] = "no-cache";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(selected).pipe(res);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  app.server.listen(port, host, () => console.log(`Smash Online server listening on http://${host}:${port}`));
}
