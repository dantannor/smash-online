import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { encodeOSI1, KINDS, clampInputMessage } from "../shared/protocol.js";

const REFRESH_MS = 100;
const TIMEOUT_MS = 500;
const neutral = () => ({ kind: KINDS.DISCONNECTED, enabled: 0, buttons: 0, sx: 0, sy: 0 });

export class Sidecar {
  constructor({ file, p1 = "keyboard", now = Date.now, onError = console.error }) {
    if (!file) throw new TypeError("an OSI1 file path is required");
    this.file = path.resolve(file);
    this.now = now;
    this.onError = onError;
    this.seq = 0;
    this.slots = Array.from({ length: 4 }, neutral);
    this.connections = Array(4).fill(null);
    this.helper = null;
    this.fd = null;
    this.closed = false;
    this.p1Mode = p1 === "keyboard" ? "keyboard" : "pad-helper";
    this.p1Input = { buttons: 0, sx: 0, sy: 0 };
    if (this.p1Mode === "keyboard") {
      this.slots[0] = { ...neutral(), kind: KINDS.GAME_WINDOW_KEYBOARD, enabled: 1 };
    }
  }

  writeSnapshot() {
    if (this.closed || this.fd === null) return;
    const snapshot = encodeOSI1({ seq: this.seq++ >>> 0, mute: 0, ports: this.slots });
    try {
      const written = fs.writeSync(this.fd, snapshot, 0, snapshot.length, 0);
      if (written !== snapshot.length) throw new Error(`short OSI1 write: ${written}/${snapshot.length} bytes`);
    } catch (error) { this.onError(error); }
  }

  start() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { this.fd = fs.openSync(this.file, "r+"); }
    catch (error) { if (error.code !== "ENOENT") throw error; this.fd = fs.openSync(this.file, "w+", 0o600); }
    if (fs.fstatSync(this.fd).size !== 80) fs.ftruncateSync(this.fd, 80);
    this.writeSnapshot();
    this.timer = setInterval(() => {
      this.writeSnapshot();
    }, REFRESH_MS);
    this.timer.unref?.();
    return this;
  }

  connect(port, connectionId, client) {
    const index = port - 1;
    if (!validPort(port) || !validConnectionId(connectionId)) return this.reject(client, "invalid_slot", "port or connectionId is invalid");
    // A replacement owns the port immediately; old IDs become stale.
    clearTimeout(this.connections[index]?.timeout);
    const connection = { id: connectionId, lastSeq: null, lastInputAt: this.now(), client, timeout: null };
    this.connections[index] = connection;
    this.armTimeout(index, connection);
    this.slots[index] = { ...neutral(), kind: KINDS.FILE_DRIVEN_PAD, enabled: 1 };
    client.sendJson({ type: "slot:connected", port });
    this.writeSnapshot();
  }

  input(port, connectionId, input, client) {
    if (!validPort(port)) return this.reject(client, "invalid_port", "port must be an integer from 1 to 4");
    const index = port - 1;
    const connection = this.connections[index];
    if (!connection || connection.id !== connectionId) return this.reject(client, "stale_connection", "connectionId is not current for this port");
    let value;
    try { value = clampInputMessage(input); }
    catch (error) { return this.reject(client, "invalid_input", error.message); }
    if (connection.lastSeq !== null && value.seq <= connection.lastSeq) return this.reject(client, "non_monotonic_seq", "seq must increase for each connection");
    connection.lastSeq = value.seq;
    connection.lastInputAt = this.now();
    this.armTimeout(index, connection);
    this.slots[index] = { kind: KINDS.FILE_DRIVEN_PAD, enabled: 1, buttons: value.buttons, sx: value.sx, sy: value.sy };
    this.writeSnapshot();
  }

  disconnect(port, connectionId, client) {
    if (!validPort(port)) return this.reject(client, "invalid_port", "port must be an integer from 1 to 4");
    const index = port - 1;
    const connection = this.connections[index];
    if (!connection || connection.id !== connectionId) return this.reject(client, "stale_connection", "connectionId is not current for this port");
    clearTimeout(connection.timeout);
    this.connections[index] = null;
    this.slots[index] = neutral();
    client.sendJson({ type: "slot:disconnected", port });
    this.writeSnapshot();
  }

  armTimeout(index, connection) {
    clearTimeout(connection.timeout);
    const remaining = Math.max(0, TIMEOUT_MS - (this.now() - connection.lastInputAt));
    connection.timeout = setTimeout(() => {
      if (this.connections[index] !== connection) return;
      const elapsed = this.now() - connection.lastInputAt;
      if (elapsed < TIMEOUT_MS) return this.armTimeout(index, connection);
      connection.timeout = null;
      this.slots[index] = { ...neutral(), kind: KINDS.FILE_DRIVEN_PAD, enabled: 1 };
      this.writeSnapshot();
    }, remaining);
    connection.timeout.unref?.();
  }

  reject(client, code, message) { client?.sendJson({ type: "error", code, message }); }

  setP1(input) {
    let value;
    try { value = clampInputMessage({ seq: this.p1Seq ?? 0, t: 0, ...input }); }
    catch (error) { this.onError(error); return false; }
    this.p1Seq = (value.seq + 1) >>> 0;
    this.p1Input = { buttons: value.buttons, sx: value.sx, sy: value.sy };
    this.slots[0] = { kind: this.p1Mode === "keyboard" ? KINDS.GAME_WINDOW_KEYBOARD : KINDS.FILE_DRIVEN_PAD, enabled: 1, ...this.p1Input };
    this.writeSnapshot();
    return true;
  }

  startHelper(command) {
    const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] });
    this.helper = child;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (!value || !["buttons", "sx", "sy"].every((key) => Number.isFinite(value[key]))) throw new TypeError("helper JSON must contain numeric buttons, sx, sy");
          this.setP1({ ...value, seq: this.p1Seq ?? 0 });
        } catch (error) { this.onError(new Error(`invalid pad-helper line: ${error.message}`)); }
      }
    });
    child.on("error", this.onError);
    child.on("exit", (code) => { if (code && !this.closed) this.onError(new Error(`pad-helper exited with code ${code}`)); });
    return child;
  }

  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.connections.forEach((connection) => clearTimeout(connection?.timeout));
    this.connections.fill(null);
    this.slots = Array.from({ length: 4 }, neutral);
    this.closed = false;
    this.writeSnapshot();
    this.closed = true;
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (error) { this.onError(error); } this.fd = null; }
    if (this.helper) {
      try {
        if (this.helper.exitCode !== null || this.helper.signalCode !== null) return;
        if (process.platform !== "win32" && this.helper.pid) process.kill(-this.helper.pid, "SIGTERM");
        else this.helper.kill("SIGTERM");
      } catch (error) {
        if (error.code === "EPERM") {
          try { this.helper.kill("SIGTERM"); } catch (fallbackError) { if (fallbackError.code !== "ESRCH") this.onError(fallbackError); }
        } else if (error.code !== "ESRCH") this.onError(error);
      }
    }
  }
}

const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 4;
const validConnectionId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;

export function createSidecarServer(sidecar, { port = 8765, host = "127.0.0.1" } = {}) {
  if (host !== "127.0.0.1") throw new Error("sidecar must bind to 127.0.0.1");
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let owner = null;
  wss.on("connection", (ws) => {
    if (owner) { ws.close(1013, "sidecar already has a host"); return; }
    const client = { sendJson: (data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } };
    owner = ws;
    client.sendJson({ type: "ready" });
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { sidecar.reject(client, "malformed_json", "message must be valid JSON"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return sidecar.reject(client, "invalid_message", "message must be an object");
      if (message.type === "slot:connect") sidecar.connect(message.port, message.connectionId, client);
      else if (message.type === "slot:input") sidecar.input(message.port, message.connectionId, message.input, client);
      else if (message.type === "slot:disconnect") sidecar.disconnect(message.port, message.connectionId, client);
      else sidecar.reject(client, "unknown_type", "unsupported message type");
    });
    ws.on("close", () => {
      if (owner === ws) owner = null;
      for (let i = 0; i < 4; i++) {
        if (sidecar.connections[i]?.client === client) {
          clearTimeout(sidecar.connections[i].timeout);
          sidecar.connections[i] = null;
          sidecar.slots[i] = neutral();
        }
      }
      sidecar.writeSnapshot();
    });
  });
  return { httpServer, wss, listen: () => new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => { httpServer.removeListener("error", reject); resolve(httpServer.address()); });
  }), close: () => new Promise((resolve) => { wss.close(() => httpServer.close(() => resolve())); }) };
}

function parseArgs(argv) {
  const args = { file: null, port: 8765, p1: "keyboard" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--port") args.port = Number(argv[++i]);
    else if (argv[i] === "--p1") args.p1 = argv[++i];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!args.file) throw new Error("usage: node sidecar/index.js --file <path> [--port 8765] [--p1 pad-helper:<cmd>]");
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("--port must be a valid TCP port");
  if (args.p1 !== "keyboard" && !args.p1.startsWith("pad-helper:")) throw new Error("--p1 must be keyboard or pad-helper:<cmd>");
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const p1 = args.p1.startsWith("pad-helper:") ? args.p1 : args.p1;
    const sidecar = new Sidecar({ file: args.file, p1 }).start();
    if (p1.startsWith("pad-helper:")) sidecar.startHelper(p1.slice("pad-helper:".length));
    const server = createSidecarServer(sidecar, { port: args.port });
    server.listen().then((address) => console.log(`sidecar listening on ws://${address.address}:${address.port}`)).catch((error) => { console.error(error); process.exitCode = 1; sidecar.close(); });
    const shutdown = () => { server.close().finally(() => { sidecar.close(); }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
