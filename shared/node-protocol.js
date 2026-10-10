import { randomBytes } from "node:crypto";

export { BUTTONS, INPUT_MAX_STICK, KINDS, MESSAGE_TYPES, OSI1, PORTS, clampInputMessage, decodeInputMessage, decodeOSI1, encodeInputMessage, encodeOSI1, makeGuestUrl, makeRoomUrl, parseRoomUrl, validateInputMessage } from "./protocol.js";

export function createToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) throw new RangeError("token size must be 16..64 bytes");
  return randomBytes(bytes).toString("base64url");
}
