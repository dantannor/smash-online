import { DurableObject } from "cloudflare:workers";

const PORTS = [1, 2, 3, 4];
const TTL_MS = 30 * 60 * 1000;
const MAX_SDP = 900_000;
const enc = new TextEncoder();
const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
const same = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const connectionId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const json = (value) => JSON.stringify(value);

export class Room extends DurableObject {
  async init({ roomTokenHash, slotTokenHashes }) {
    await this.ctx.storage.put("meta", { roomTokenHash, slotTokenHashes });
    await this.touch();
  }

  async touch() { await this.ctx.storage.setAlarm(Date.now() + TTL_MS); }

  async join(slotToken) {
    const meta = await this.ctx.storage.get("meta");
    if (!meta) return { error: "ROOM_NOT_FOUND" };
    const supplied = await sha256(typeof slotToken === "string" ? slotToken : "");
    const port = PORTS.find((candidate) => meta.slotTokenHashes[candidate] && same(fromHex(meta.slotTokenHashes[candidate]), supplied));
    if (!port) return { error: "UNAUTHORIZED" };
    await this.touch();
    return { port };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = url.searchParams.get("role");
    const port = Number(url.searchParams.get("port"));
    const supplied = await sha256(url.searchParams.get("token") || "");
    const meta = await this.ctx.storage.get("meta");
    const reject = (code, message) => { server.accept(); server.send(json({ type: "error", code, message })); server.close(1008, "unauthorized"); return new Response(null, { status: 101, webSocket: client }); };
    if (!meta) return reject("ROOM_NOT_FOUND", "Room not found or expired");
    let authorized = false;
    if (role === "host") authorized = same(fromHex(meta.roomTokenHash), supplied);
    if (role === "guest" && PORTS.includes(port) && meta.slotTokenHashes[port]) authorized = same(fromHex(meta.slotTokenHashes[port]), supplied);
    if (!authorized) return reject("UNAUTHORIZED", "Invalid room credentials");
    await this.touch();
    if (role === "host") {
      for (const old of this.ctx.getWebSockets("host")) { try { old.close(4001, "host replaced"); } catch { /* already closed */ } }
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host" });
      for (const slotPort of PORTS) {
        const live = this.slotSocket(slotPort);
        if (live) server.send(json({ type: "slot:connected", port: slotPort, connectionId: live.attachment.connectionId }));
      }
    } else {
      const id = connectionId();
      for (const old of this.ctx.getWebSockets(`slot:${port}`)) {
        try { old.send(json({ type: "error", code: "SLOT_REPLACED", message: "This link was opened in another tab" })); old.close(4001, "slot replaced"); } catch { /* already closed */ }
      }
      this.ctx.acceptWebSocket(server, [`slot:${port}`]);
      server.serializeAttachment({ role: "guest", port, connectionId: id });
      await this.ctx.storage.put(`conn:${port}`, id);
      this.sendHost({ type: "slot:connected", port, connectionId: id });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  slotSocket(port) {
    for (const ws of this.ctx.getWebSockets(`slot:${port}`)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = ws.deserializeAttachment();
      if (attachment?.connectionId) return { ws, attachment };
    }
    return null;
  }

  sendHost(message) {
    for (const ws of this.ctx.getWebSockets("host")) if (ws.readyState === WebSocket.OPEN) ws.send(json(message));
  }

  sendError(ws, code, message) { ws.send(json({ type: "error", code, message })); }

  async webSocketMessage(ws, data) {
    const attachment = ws.deserializeAttachment() || {};
    if (typeof data !== "string") return this.sendError(ws, "BAD_MESSAGE", "Messages must be JSON text");
    let message;
    try { message = JSON.parse(data); } catch { return this.sendError(ws, "BAD_MESSAGE", "Invalid JSON envelope"); }
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.sendError(ws, "BAD_MESSAGE", "Expected a JSON envelope");
    const { type } = message;
    if (attachment.role === "host" && type === "offer") {
      if (!PORTS.includes(message.port) || typeof message.sdp !== "string" || message.sdp.length > MAX_SDP) return this.sendError(ws, "BAD_MESSAGE", "Invalid offer");
      this.slotSocket(message.port)?.ws.send(json({ type, port: message.port, sdp: message.sdp }));
    } else if (attachment.role === "guest" && type === "answer") {
      if (typeof message.sdp !== "string" || message.sdp.length > MAX_SDP) return this.sendError(ws, "BAD_MESSAGE", "Invalid answer");
      this.sendHost({ type, port: attachment.port, sdp: message.sdp });
    } else if ((attachment.role === "host" || attachment.role === "guest") && type === "ice") {
      if (!Object.hasOwn(message, "candidate") || json(message.candidate).length > 100_000) return this.sendError(ws, "BAD_MESSAGE", "Invalid ICE candidate");
      if (attachment.role === "host") {
        if (!PORTS.includes(message.port)) return this.sendError(ws, "BAD_MESSAGE", "Invalid port");
        this.slotSocket(message.port)?.ws.send(json({ type, port: message.port, candidate: message.candidate }));
      } else this.sendHost({ type, port: attachment.port, candidate: message.candidate });
    } else return this.sendError(ws, "INVALID_OPERATION", "Message type is not allowed for this role");
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment || attachment.role !== "guest") return;
    const current = await this.ctx.storage.get(`conn:${attachment.port}`);
    if (current !== attachment.connectionId) return;
    await this.ctx.storage.delete(`conn:${attachment.port}`);
    this.sendHost({ type: "slot:disconnected", port: attachment.port, connectionId: attachment.connectionId });
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  async alarm() {
    const open = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    if (open.length) { await this.touch(); return; }
    await this.ctx.storage.deleteAll();
  }
}
