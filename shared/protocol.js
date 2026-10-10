import { randomBytes } from "node:crypto";

export const OSI1 = Object.freeze({ MAGIC: "OSI1", SIZE: 80, HEADER_SIZE: 8, PORT_SIZE: 16, PORTS: 4 });

export const BUTTONS = Object.freeze({
  A: 0x8000, B: 0x4000, Z: 0x2000, START: 0x1000,
  UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100,
  L: 0x0020, R: 0x0010, C_UP: 0x0008, C_DOWN: 0x0004, C_LEFT: 0x0002, C_RIGHT: 0x0001,
});
export const PORTS = Object.freeze({ P1: 0, P2: 1, P3: 2, P4: 3 });
export const KINDS = Object.freeze({ DISCONNECTED: 0, GAME_WINDOW_KEYBOARD: 2, FILE_DRIVEN_PAD: 3 });
export const MESSAGE_TYPES = Object.freeze({
  ROOM_CREATE: "room:create", ROOM_CREATED: "room:created", ROOM_JOIN: "room:join", ROOM_JOINED: "room:joined",
  OFFER: "offer", ANSWER: "answer", ICE: "ice", INPUT: "input",
  SLOT_CONNECTED: "slot:connected", SLOT_DISCONNECTED: "slot:disconnected", ERROR: "error",
});

export const INPUT_MAX_STICK = 80;
const UINT32_MAX = 0xffffffff;

export function clampInputMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("input must be an object");
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq > UINT32_MAX) throw new RangeError("seq must be a uint32");
  if (!Number.isFinite(input.t) || input.t < 0) throw new RangeError("t must be a non-negative timestamp");
  if (!Number.isFinite(input.buttons)) throw new TypeError("buttons must be finite");
  if (!Number.isFinite(input.sx) || !Number.isFinite(input.sy)) throw new TypeError("stick axes must be finite");
  return {
    seq: input.seq >>> 0,
    t: input.t,
    buttons: Math.max(0, Math.min(0xffff, Math.trunc(input.buttons))),
    sx: Math.max(-INPUT_MAX_STICK, Math.min(INPUT_MAX_STICK, Math.trunc(input.sx))),
    sy: Math.max(-INPUT_MAX_STICK, Math.min(INPUT_MAX_STICK, Math.trunc(input.sy))),
  };
}

export function validateInputMessage(input) {
  try { clampInputMessage(input); return true; } catch { return false; }
}

export function encodeInputMessage(input) {
  return JSON.stringify(clampInputMessage(input));
}

export function decodeInputMessage(message) {
  let value;
  try { value = typeof message === "string" ? JSON.parse(message) : JSON.parse(Buffer.from(message).toString("utf8")); }
  catch { throw new TypeError("input message must be valid JSON"); }
  return clampInputMessage(value);
}

function asPort(port, index) {
  if (!port || typeof port !== "object") throw new TypeError(`ports[${index}] must be an object`);
  for (const key of ["kind", "buttons", "sx", "sy"]) {
    if (!Number.isFinite(port[key])) throw new TypeError(`ports[${index}].${key} must be finite`);
  }
  if (typeof port.enabled !== "boolean" && !Number.isFinite(port.enabled)) throw new TypeError(`ports[${index}].enabled must be finite`);
  if (!Number.isInteger(port.kind) || port.kind < 0 || port.kind > 255) throw new RangeError(`ports[${index}].kind must be a uint8`);
  if (port.enabled !== 0 && port.enabled !== 1 && port.enabled !== false && port.enabled !== true) throw new RangeError(`ports[${index}].enabled must be boolean or 0/1`);
  return {
    kind: port.kind,
    enabled: Number(Boolean(port.enabled)),
    buttons: Math.max(0, Math.min(0xffff, Math.trunc(port.buttons))),
    sx: Math.max(-32768, Math.min(32767, Math.trunc(port.sx))),
    sy: Math.max(-32768, Math.min(32767, Math.trunc(port.sy))),
  };
}

export function encodeOSI1({ seq, mute = 0, ports }) {
  if (!Number.isInteger(seq) || seq < 0 || seq > UINT32_MAX) throw new RangeError("seq must be a uint32");
  if (mute !== 0 && mute !== 1 && mute !== false && mute !== true) throw new RangeError("mute must be boolean or 0/1");
  if (!Array.isArray(ports) || ports.length !== OSI1.PORTS) throw new RangeError("ports must contain exactly four entries");
  const buffer = Buffer.alloc(OSI1.SIZE);
  buffer.write(OSI1.MAGIC, 0, "ascii");
  buffer[4] = Number(Boolean(mute));
  buffer[5] = seq & 0xff;
  ports.map(asPort).forEach((port, index) => {
    const offset = OSI1.HEADER_SIZE + OSI1.PORT_SIZE * index;
    buffer[offset] = port.kind;
    buffer[offset + 1] = port.enabled;
    buffer.writeUInt16LE(port.buttons, offset + 2);
    buffer.writeInt16LE(port.sx, offset + 4);
    buffer.writeInt16LE(port.sy, offset + 6);
  });
  return buffer;
}

export function decodeOSI1(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length !== OSI1.SIZE || buffer.toString("ascii", 0, 4) !== OSI1.MAGIC) throw new TypeError("invalid OSI1 buffer");
  return {
    mute: buffer[4], seq: buffer[5],
    ports: Array.from({ length: OSI1.PORTS }, (_, index) => {
      const offset = OSI1.HEADER_SIZE + OSI1.PORT_SIZE * index;
      return {
        kind: buffer[offset], enabled: buffer[offset + 1],
        buttons: buffer.readUInt16LE(offset + 2), sx: buffer.readInt16LE(offset + 4), sy: buffer.readInt16LE(offset + 6),
      };
    }),
  };
}

export function makeRoomUrl(origin, room) {
  const url = new URL("/host", origin);
  url.searchParams.set("room", requireTokenPart(room, "room"));
  return url.toString();
}

export function makeGuestUrl(origin, room, slotToken) {
  const url = new URL("/play", origin);
  url.searchParams.set("room", requireTokenPart(room, "room"));
  url.searchParams.set("slot", requireTokenPart(slotToken, "slot token"));
  return url.toString();
}

export function parseRoomUrl(value) {
  const url = new URL(value);
  const room = url.searchParams.get("room");
  if (!room) throw new TypeError("URL is missing room");
  return { origin: url.origin, path: url.pathname, room };
}

export function createToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) throw new RangeError("token size must be 16..64 bytes");
  return randomBytes(bytes).toString("base64url");
}

function requireTokenPart(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new TypeError(`${label} must be an 8..128 character URL-safe token`);
  return value;
}
