import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeOSI1, KINDS } from "../shared/protocol.js";

const target = process.env.OPENSMASH_LAUNCHER_INPUT || "/tmp/smash-online-input.osi1";
const ports = Array.from({ length: 4 }, (_, index) => ({
  kind: index === 0 ? KINDS.GAME_WINDOW_KEYBOARD : KINDS.FILE_DRIVEN_PAD,
  enabled: true,
  buttons: 0,
  sx: 0,
  sy: 0,
}));
const data = encodeOSI1({ seq: 0, mute: 0, ports });
const temporary = `${target}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(temporary, data, { mode: 0o600 });
await rename(temporary, target);
console.log(target);
