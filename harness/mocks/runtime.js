import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import { encodeOSI1, PORTS, KINDS, clampInputMessage } from "../../shared/protocol.js";

const neutral = () => ({ kind: KINDS.DISCONNECTED, enabled: 0, buttons: 0, sx: 0, sy: 0 });

export async function startMockRuntime() {
  const room = "mock-room-0001";
  const roomToken = "mock-room-token-00000000000000000001";
  const slots = [2, 3, 4].map((port) => ({
    port, slotToken: `mock-slot-token-p${port}-0000000001`,
    guestUrl: `/play?room=${room}`,
  }));
  const state = {
    ports: Array.from({ length: 4 }, neutral),
    receiptTimes: [],
    seq: 0,
    hostInput: { seq: 0, t: 0, buttons: 0, sx: 0, sy: 0 },
    connected: new Map(),
    getOSI1() { return encodeOSI1({ seq: this.seq++, ports: this.ports }); },
  };
  const activeGuests = new Map();
  const lastSequences = new Map();
  const lastInputAt = new Map();
  let origin;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ room, roomToken, hostUrl: `${origin}/host?room=${room}`, slots: slots.map((slot) => ({ ...slot, guestUrl: `${origin}/play?room=${room}&slot=${slot.slotToken}` })) }));
      return;
    }
    if (req.method === "POST" && url.pathname === `/api/rooms/${room}/join`) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let input;
        try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        const slot = slots.find((candidate) => candidate.slotToken === input.slotToken);
        if (!slot) { res.writeHead(403).end(); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ port: slot.port, slotSession: `session-p${slot.port}` }));
      });
      return;
    }
    const pageFiles = { "/host": "host.html", "/host.js": "host.js", "/play": "guest.html", "/guest.js": "guest.js" };
    if (req.method === "GET" && pageFiles[url.pathname]) {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages", pageFiles[url.pathname]);
      res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
      readFile(file).then((body) => res.end(body), () => res.writeHead(404).end());
      return;
    }
    if (req.method === "GET" && url.pathname === "/mock/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ports: state.ports, connected: [...state.connected.keys()], receiptTimes: state.receiptTimes }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/mock/osi1") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(state.getOSI1());
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const wss = new WebSocketServer({ server, path: "/ws" });
  const sidecar = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    sidecar.once("listening", resolve);
    sidecar.once("error", reject);
  });
  const sidecarUrl = `ws://127.0.0.1:${sidecar.address().port}`;
  sidecar.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "ready" }));
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const validPort = Number.isInteger(message.port) && message.port >= 1 && message.port <= 4;
      if (message.type === "slot:connect" && validPort && typeof message.connectionId === "string") {
        state.connect(message.port, message.connectionId); lastInputAt.set(message.port, Date.now());
        ws.send(JSON.stringify({ type: "slot:connected", port: message.port }));
      } else if (message.type === "slot:input") {
        if (!validPort || state.connected.get(message.port) !== message.connectionId || !message.input || !Number.isInteger(message.input.seq) || (lastSequences.has(message.port) && message.input.seq <= lastSequences.get(message.port))) {
          ws.send(JSON.stringify({ type: "error", code: "invalid_input", message: "invalid, stale, or non-monotonic input" })); return;
        }
        try { state.setInput(message.port, message.input); lastSequences.set(message.port, message.input.seq); lastInputAt.set(message.port, Date.now()); }
        catch { ws.send(JSON.stringify({ type: "error", code: "invalid_input", message: "malformed input" })); }
      } else if (message.type === "slot:disconnect" && validPort && state.connected.get(message.port) === message.connectionId) {
        state.disconnect(message.port, message.connectionId); lastInputAt.delete(message.port);
        ws.send(JSON.stringify({ type: "slot:disconnected", port: message.port }));
      } else if (["slot:connect", "slot:disconnect"].includes(message.type) || message.type === "slot:input") {
        ws.send(JSON.stringify({ type: "error", code: "invalid_slot", message: "invalid port or connection" }));
      }
    });
  });
  const relay = (roomId, targetRole, payload) => {
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.room === roomId && client.role === targetRole && (targetRole !== "guest" || client.port === payload.port)) client.send(JSON.stringify(payload));
    }
  };
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, origin);
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");
    const port = Number(url.searchParams.get("port"));
    const valid = role === "host" ? token === roomToken : role === "guest" && slots.some((slot) => slot.port === port && slot.slotToken === token);
    if (!valid) { ws.close(1008, "unauthorized"); return; }
    ws.room = room; ws.role = role; ws.port = port;
    if (role === "guest") {
      activeGuests.get(port)?.close(4000, "replaced");
      ws.connectionId = `connection-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      activeGuests.set(port, ws);
      lastSequences.delete(port);
      relay(room, "host", { type: "slot:connected", port, connectionId: ws.connectionId });
    }
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { ws.send(JSON.stringify({ type: "error", code: "malformed", message: "invalid JSON" })); return; }
        const targetRole = role === "host" ? "guest" : "host";
      if (["offer", "answer", "ice"].includes(message.type)) relay(room, targetRole, { ...message, port: message.port ?? port });
    });
    ws.on("close", () => {
      if (role === "guest" && activeGuests.get(port) === ws) {
        activeGuests.delete(port);
        relay(room, "host", { type: "slot:disconnected", port, connectionId: ws.connectionId });
      }
    });
  });
  state.setInput = (port, input) => {
    const normalized = clampInputMessage(input);
    const index = PORTS[`P${port}`];
    state.ports[index] = { kind: KINDS.FILE_DRIVEN_PAD, enabled: 1, ...normalized };
    state.receiptTimes.push({ port, t: normalized.t, buttons: normalized.buttons, sx: normalized.sx, sy: normalized.sy, receivedAt: performance.timeOrigin + performance.now() });
    if (state.receiptTimes.length > 1000) state.receiptTimes.splice(0, state.receiptTimes.length - 1000);
  };
  state.disconnect = (port, connectionId) => {
    if (connectionId && state.connected.get(port) !== connectionId) return;
    state.ports[PORTS[`P${port}`]] = neutral(); state.connected.delete(port); lastSequences.delete(port); lastInputAt.delete(port);
  };
  state.connect = (port, id) => { state.connected.set(port, id); state.ports[PORTS[`P${port}`]] = { ...neutral(), kind: KINDS.FILE_DRIVEN_PAD, enabled: 1 }; lastSequences.delete(port); };
  const freshness = setInterval(() => {
    for (const [port, connectionId] of state.connected) {
      if (Date.now() - (lastInputAt.get(port) ?? Date.now()) > 500) state.disconnect(port, connectionId);
      else state.seq = (state.seq + 1) >>> 0;
    }
  }, 75);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(freshness);
    for (const ws of wss.clients) ws.terminate();
    for (const ws of sidecar.clients) ws.terminate();
    await Promise.all([
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => sidecar.close(resolve)),
    ]);
    await new Promise((resolve) => server.listening ? server.close(resolve) : resolve());
  };
  return { origin, server, wss, sidecar, sidecarUrl, state, slots, close };
}
