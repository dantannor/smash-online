import test from "node:test";
import assert from "node:assert/strict";
import {
  BUTTONS, KINDS, PORTS, clampInputMessage, decodeInputMessage,
  decodeOSI1, encodeInputMessage, encodeOSI1, makeGuestUrl, makeRoomUrl,
  parseRoomUrl, validateInputMessage,
} from "./protocol.js";
import { createToken } from "./node-protocol.js";

// Minimal golden bytes captured from opensmash/desktop/input.cjs createInput().update().
// Source: https://github.com/turtlesoupy/opensmash/blob/main/desktop/input.cjs
const WRITER_FIXTURE_HEX = [
  "4f53493100010000",
  "020100805000b0ff0000000000000000",
  "03010140ffff01000000000000000000",
  "00000000000000000000000000000000",
  "0300ffff5000b0ff0000000000000000",
  "0000000000000000",
].join("");

test("OSI1 encoder matches byte-for-byte opensmash writer fixture", () => {
  const packet = encodeOSI1({ seq: 1, mute: 0, ports: [
    { kind: 2, enabled: 1, buttons: 0x8000, sx: 80, sy: -80 },
    { kind: 3, enabled: 1, buttons: 0x4001, sx: -1, sy: 1 },
    { kind: 0, enabled: 0, buttons: 0, sx: 0, sy: 0 },
    { kind: 3, enabled: 0, buttons: 0xffff, sx: 80, sy: -80 },
  ] });
  assert.equal(packet.length, 80);
  assert.equal(Buffer.from(packet).toString("hex"), WRITER_FIXTURE_HEX);
});

test("OSI1 decoder round-trips the consumed port fields", () => {
  const value = { seq: 257, mute: false, ports: Array.from({ length: 4 }, (_, i) => ({
    kind: i === 0 ? KINDS.GAME_WINDOW_KEYBOARD : KINDS.FILE_DRIVEN_PAD,
    enabled: i !== 3, buttons: BUTTONS.A | BUTTONS.C_RIGHT, sx: i * 10, sy: i === 0 ? 0 : -i * 10,
  })) };
  const decoded = decodeOSI1(encodeOSI1(value));
  assert.equal(decoded.seq, 1);
  assert.equal(decoded.mute, 0);
  assert.deepEqual(decoded.ports, value.ports.map(p => ({ ...p, enabled: Number(p.enabled) })));
});

test("input messages clamp sticks and button masks, and reject malformed fields", () => {
  const clamped = clampInputMessage({ seq: 7, t: 123.5, buttons: 90000, sx: -100, sy: 12.8 });
  assert.deepEqual(clamped, { seq: 7, t: 123.5, buttons: 0xffff, sx: -80, sy: 12 });
  assert.deepEqual(decodeInputMessage(encodeInputMessage(clamped)), clamped);
  assert.equal(validateInputMessage({ seq: 1, t: 0, buttons: 0, sx: 0, sy: 0 }), true);
  assert.equal(validateInputMessage({ seq: -1, t: 0, buttons: 0, sx: 0, sy: 0 }), false);
  assert.throws(() => decodeInputMessage("not json"));
});

test("room and guest URLs encode room and per-slot tokens", () => {
  const room = "room_12345678";
  const slot = createToken(16);
  assert.equal(slot.length, 22);
  const host = makeRoomUrl("https://smash.example", room);
  const guest = makeGuestUrl("https://smash.example", room, slot);
  assert.deepEqual(parseRoomUrl(host), { origin: "https://smash.example", path: "/host", room });
  const parsedGuest = new URL(guest);
  assert.equal(parsedGuest.pathname, "/play");
  assert.equal(parsedGuest.searchParams.get("room"), room);
  assert.equal(parsedGuest.searchParams.get("slot"), slot);
  assert.equal(PORTS.P4, 3);
  assert.throws(() => makeGuestUrl("https://smash.example", room, "bad"));
});
