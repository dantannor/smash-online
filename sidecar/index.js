import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { encodeOSI1, KINDS, clampInputMessage } from "../shared/protocol.js";

const REFRESH_MS = 100;
const END_ACK_MS = 3000; // how long a Back to menu request waits for the game to acknowledge it
const INTRO_IDLE_MS = 60_000; // nobody connected this long = the game is idle
const MIN_PRESS_MS = 20; // the game samples the file once per 16.7 ms frame; a press shorter than that can fall between two samples
const DEFAULT_TIMEOUT_MS = 500; // class default (contract); the CLI passes a longer one, see --input-timeout-ms
const neutral = () => ({ kind: KINDS.DISCONNECTED, enabled: 0, buttons: 0, sx: 0, sy: 0 });

export class Sidecar {
  constructor({ file, p1 = "keyboard", mute = false, inputTimeoutMs = DEFAULT_TIMEOUT_MS, rosterPageFile = null, rosterPickFile = null, introIdleMs = INTRO_IDLE_MS, now = Date.now, onError = console.error }) {
    if (!file) throw new TypeError("an OSI1 file path is required");
    this.file = path.resolve(file);
    this.now = now;
    this.rosterPickFile = rosterPickFile;
    this.pendingEnd = null; // Back to menu request waiting for the game's ack: { seq, port, client, until }
    this.introIdleMs = introIdleMs;
    this.lastOccupiedAt = now(); // last time any guest was connected; a guest arriving after introIdleMs of nobody restarts the game's intro
    this.rosterPageFile = rosterPageFile; // character-select page jumps for the native game (see cloud/vm/roster-page.patch)
    this.timeoutMs = inputTimeoutMs; // silence longer than this neutralizes a guest; shorter stalls hold the last input
    this.onError = onError;
    this.seq = 0;
    this.slots = Array.from({ length: 4 }, neutral);
    this.connections = Array(4).fill(null);
    this.helper = null;
    this.fd = null;
    this.closed = false;
    this.mute = Boolean(mute);
    this.p1Mode = p1 === "keyboard" ? "keyboard" : "pad-helper";
    this.p1Input = { buttons: 0, sx: 0, sy: 0 };
    if (this.p1Mode === "keyboard") {
      this.slots[0] = { ...neutral(), kind: KINDS.GAME_WINDOW_KEYBOARD, enabled: 1 };
    }
  }

  writeSnapshot() {
    if (this.closed || this.fd === null) return;
    const snapshot = encodeOSI1({ seq: this.seq++ >>> 0, mute: this.mute ? 1 : 0, ports: this.slots });
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
      if (this.connections.some(Boolean)) this.lastOccupiedAt = this.now();
      this.checkEndAck();
      this.writeSnapshot();
    }, REFRESH_MS);
    this.timer.unref?.();
    return this;
  }

  connect(port, connectionId, client) {
    const index = port - 1;
    if (!validPort(port) || !validConnectionId(connectionId)) return this.reject(client, "invalid_slot", "port or connectionId is invalid");
    // A replacement owns the port immediately; old IDs become stale.
    // First guest into an idle game (nobody for a while): ask the game to restart its intro. The game only does so from the title,
    // attract demo or menus (never in a match), and never when another guest is already connected.
    if (!this.connections.some(Boolean) && this.now() - this.lastOccupiedAt >= this.introIdleMs) this.requestIntro();
    clearTimeout(this.connections[index]?.timeout);
    clearTimeout(this.connections[index]?.holdTimer);
    const connection = { id: connectionId, lastSeq: null, lastInputAt: this.now(), client, timeout: null, buttons: 0, holdMask: 0, holdUntil: 0, holdTimer: null };
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
    this.holdNewPresses(connection, value.buttons);
    this.slots[index] = { kind: KINDS.FILE_DRIVEN_PAD, enabled: 1, buttons: this.heldButtons(connection), sx: value.sx, sy: value.sy };
    this.writeSnapshot();
    this.armHold(index, connection);
  }

  // Network jitter can bunch a press and its release into one burst, so the file would show the press for under a frame and the game
  // would never see it. A newly pressed button therefore stays in the file for MIN_PRESS_MS even if its release has already arrived.
  holdNewPresses(connection, buttons) {
    const now = this.now();
    const live = now < connection.holdUntil ? connection.holdMask : 0;
    const added = buttons & ~connection.buttons;
    connection.buttons = buttons;
    if (added) { connection.holdMask = live | added; connection.holdUntil = now + MIN_PRESS_MS; }
    else if (!live) connection.holdMask = 0;
  }

  heldButtons(connection) {
    return connection.buttons | (this.now() < connection.holdUntil ? connection.holdMask : 0);
  }

  armHold(index, connection) {
    clearTimeout(connection.holdTimer);
    connection.holdTimer = null;
    if ((connection.holdMask & ~connection.buttons) === 0) return;
    connection.holdTimer = setTimeout(() => {
      connection.holdTimer = null;
      if (this.connections[index] !== connection) return;
      this.slots[index] = { ...this.slots[index], buttons: this.heldButtons(connection) };
      this.writeSnapshot();
    }, Math.max(0, connection.holdUntil - this.now()));
    connection.holdTimer.unref?.();
  }

  disconnect(port, connectionId, client) {
    if (!validPort(port)) return this.reject(client, "invalid_port", "port must be an integer from 1 to 4");
    const index = port - 1;
    const connection = this.connections[index];
    if (!connection || connection.id !== connectionId) return this.reject(client, "stale_connection", "connectionId is not current for this port");
    clearTimeout(connection.timeout);
    clearTimeout(connection.holdTimer);
    this.connections[index] = null;
    this.slots[index] = neutral();
    client.sendJson({ type: "slot:disconnected", port });
    this.writeSnapshot();
  }

  armTimeout(index, connection) {
    clearTimeout(connection.timeout);
    const remaining = Math.max(0, this.timeoutMs - (this.now() - connection.lastInputAt));
    connection.timeout = setTimeout(() => {
      if (this.connections[index] !== connection) return;
      const elapsed = this.now() - connection.lastInputAt;
      if (elapsed < this.timeoutMs) return this.armTimeout(index, connection);
      connection.timeout = null;
      clearTimeout(connection.holdTimer);
      connection.buttons = 0;
      connection.holdUntil = 0;
      this.slots[index] = { ...neutral(), kind: KINDS.FILE_DRIVEN_PAD, enabled: 1 };
      this.writeSnapshot();
    }, remaining);
    connection.timeout.unref?.();
  }

  // The game polls this file ("<seq> <page>"); a new seq is a page request, like the web shell's search dialog.
  requestRosterPage(page, client) {
    if (!this.rosterPageFile) return this.reject(client, "roster_unavailable", "this sidecar has no roster page file");
    if (!Number.isInteger(page) || page < 0 || page > 4096) return this.reject(client, "invalid_page", "page must be an integer from 0 to 4095");
    try { fs.writeFileSync(this.rosterPageFile, `${Date.now()} ${page}\n`); }
    catch (error) { this.onError(error); }
  }

  // idx >= 0: custom fighter (registry row); idx < 0: original on tile fkind -1 - idx. The game polls this file ("<seq> <player> <idx>").
  requestRosterPick(port, idx, client) {
    if (!this.rosterPickFile) return this.reject(client, "roster_unavailable", "this sidecar has no roster pick file");
    if (!validPort(port) || !Number.isInteger(idx) || idx < -12 || idx > 4095) return this.reject(client, "invalid_pick", "bad port or fighter");
    try { fs.writeFileSync(this.rosterPickFile, `${Date.now()} ${port - 1} ${idx}\n`); }
    catch (error) { this.onError(error); }
  }

  // "<seq> 20 0 0": restart the intro (see cloud/vm/intro-hook.patch).
  requestIntro() {
    if (!this.rosterPickFile) return;
    try { fs.writeFileSync(this.rosterPickFile, `${Date.now()} 20 0 0\n`); }
    catch (error) { this.onError(error); }
  }

  // Play vs CPU: "<seq> <10 + player> <bitmask of connected ports> <cpu count>". The game fills the ports that are not connected with CPUs and starts the match.
  requestSolo(port, cpus, client) {
    if (!this.rosterPickFile) return this.reject(client, "roster_unavailable", "this sidecar has no roster pick file");
    if (!validPort(port) || !Number.isInteger(cpus) || cpus < 1 || cpus > 3) return this.reject(client, "invalid_solo", "bad port or CPU count");
    const mask = this.connections.reduce((bits, connection, index) => (connection ? bits | (1 << index) : bits), 1 << (port - 1));
    try { fs.writeFileSync(this.rosterPickFile, `${Date.now()} ${9 + port} ${mask} ${cpus}\n`); }
    catch (error) { this.onError(error); }
  }

  // Back to menu: "<seq> 30 <player - 1> 0". The game only acts on it during a VS match, and then writes "<seq> <player - 1>" to
  // "<pick file>.ack"; that ack (not the request) is what makes the sidecar report match:ended, so a click anywhere else is silent.
  requestEndMatch(port, client) {
    if (!this.rosterPickFile) return this.reject(client, "roster_unavailable", "this sidecar has no roster pick file");
    if (!validPort(port)) return this.reject(client, "invalid_end", "bad port");
    const seq = this.now();
    try { fs.writeFileSync(this.rosterPickFile, `${seq} 30 ${port - 1} 0\n`); }
    catch (error) { this.onError(error); return; }
    this.pendingEnd = { seq, port, client, until: seq + END_ACK_MS };
  }

  checkEndAck() {
    const pending = this.pendingEnd;
    if (!pending) return;
    if (this.now() > pending.until) { this.pendingEnd = null; return; }
    let text;
    try { text = fs.readFileSync(`${this.rosterPickFile}.ack`, "utf8"); } catch { return; }
    if (Number(text.split(/\s+/)[0]) !== pending.seq) return;
    this.pendingEnd = null;
    pending.client?.sendJson({ type: "match:ended", port: pending.port });
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
    this.connections.forEach((connection) => { clearTimeout(connection?.timeout); clearTimeout(connection?.holdTimer); });
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
      if (process.env.SMASH_DEBUG === "1") console.log(`[sidecar] type=${message.type} port=${Number.isInteger(message.port) ? message.port : "invalid"}`);
      if (message.type === "slot:connect") sidecar.connect(message.port, message.connectionId, client);
      else if (message.type === "slot:input") sidecar.input(message.port, message.connectionId, message.input, client);
      else if (message.type === "mute" && typeof message.value === "boolean") { sidecar.mute = message.value; sidecar.writeSnapshot(); }
      else if (message.type === "roster:pick") sidecar.requestRosterPick(message.port, message.idx, client);
      else if (message.type === "roster:solo") sidecar.requestSolo(message.port, message.cpus, client);
      else if (message.type === "match:end") sidecar.requestEndMatch(message.port, client);
      else if (message.type === "roster:page") sidecar.requestRosterPage(message.page, client);
      else if (message.type === "slot:disconnect") sidecar.disconnect(message.port, message.connectionId, client);
      else sidecar.reject(client, "unknown_type", "unsupported message type");
    });
    ws.on("close", () => {
      if (owner === ws) owner = null;
      for (let i = 0; i < 4; i++) {
        if (sidecar.connections[i]?.client === client) {
          clearTimeout(sidecar.connections[i].timeout);
          clearTimeout(sidecar.connections[i].holdTimer);
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
  }), terminate: () => { for (const ws of wss.clients) ws.terminate(); },
  close: () => new Promise((resolve) => { wss.close(() => httpServer.close(() => resolve())); }) };
}

function parseArgs(argv) {
  const args = { file: null, port: 8765, p1: "keyboard", mute: false, inputTimeoutMs: 2500, rosterPageFile: null, rosterPickFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--port") args.port = Number(argv[++i]);
    else if (argv[i] === "--p1") args.p1 = argv[++i];
    else if (argv[i] === "--mute") args.mute = true;
    else if (argv[i] === "--input-timeout-ms") args.inputTimeoutMs = Number(argv[++i]);
    else if (argv[i] === "--roster-page-file") args.rosterPageFile = argv[++i];
    else if (argv[i] === "--roster-pick-file") args.rosterPickFile = argv[++i];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!args.file) throw new Error("usage: node sidecar/index.js --file <path> [--port 8765] [--p1 pad-helper:<cmd>] [--mute] [--input-timeout-ms 2500]");
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("--port must be a valid TCP port");
  if (!Number.isFinite(args.inputTimeoutMs) || args.inputTimeoutMs < 100) throw new Error("--input-timeout-ms must be at least 100");
  if (args.p1 !== "keyboard" && !args.p1.startsWith("pad-helper:")) throw new Error("--p1 must be keyboard or pad-helper:<cmd>");
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const p1 = args.p1.startsWith("pad-helper:") ? args.p1 : args.p1;
    const sidecar = new Sidecar({ file: args.file, p1, mute: args.mute, inputTimeoutMs: args.inputTimeoutMs, rosterPageFile: args.rosterPageFile, rosterPickFile: args.rosterPickFile }).start();
    if (p1.startsWith("pad-helper:")) sidecar.startHelper(p1.slice("pad-helper:".length));
    const server = createSidecarServer(sidecar, { port: args.port });
    server.listen().then((address) => console.log(`sidecar listening on ws://${address.address}:${address.port}`)).catch((error) => { console.error(error); process.exitCode = 1; sidecar.close(); });
    // wss.close() waits on open clients, so a connected host page blocked exit: drop them, flush neutral, exit.
    let stopping = false;
    const shutdown = () => {
      if (stopping) process.exit(1);
      stopping = true;
      try { server.terminate(); } catch (error) { console.error(error); }
      try { sidecar.close(); } catch (error) { console.error(error); }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
