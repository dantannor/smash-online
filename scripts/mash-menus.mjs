#!/usr/bin/env node
// Menu button masher for crash repro: writes random pad input for all four ports into the OSI1 file, in place (the game
// keeps the fd open), the way the sidecar does. Start/A/B/D-pad/Z/L/R/C all get hit, so the game wanders through the
// character select, stage select, matches, results and back.
// --picks N also hits the roster pick and page files (next to the OSI1 file, like the sidecar does) N times a second: random fighter
// rows for random ports, page jumps, now and then a Play vs CPU request. --fighters is the number of registry rows (roster.txt lines).
// usage: mash-menus.mjs [--file F] [--seconds N] [--hz N] [--seed N] [--ports 1111] [--start-bias P] [--picks N] [--fighters N]
import { open } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUTTONS, KINDS, encodeOSI1 } from "../shared/protocol.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const file = opt("file", process.env.OPENSMASH_LAUNCHER_INPUT || "/tmp/smash-online-input.osi1");
const seconds = Number(opt("seconds", 600));
const hz = Number(opt("hz", 20));
const startBias = Number(opt("start-bias", 0.04));
const ports = String(opt("ports", "1111"));
const picks = Number(opt("picks", 0));
const fighters = Number(opt("fighters", 1000));
const dir = dirname(file);
let rng = Number(opt("seed", 1)) >>> 0 || 1;
const rand = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 4294967296; };

const pool = [BUTTONS.A, BUTTONS.A, BUTTONS.B, BUTTONS.Z, BUTTONS.UP, BUTTONS.DOWN, BUTTONS.LEFT, BUTTONS.RIGHT, BUTTONS.L, BUTTONS.R,
  BUTTONS.C_UP, BUTTONS.C_DOWN, BUTTONS.C_LEFT, BUTTONS.C_RIGHT, 0, 0];
const handle = await open(file, "r+");
const end = Date.now() + seconds * 1000;
let seq = 1, presses = 0, requests = 0;
const request = () => {
  const r = rand(), stamp = Date.now() * 10 + (requests++ % 10);   // a new seq every time, even within one millisecond
  if (r < 0.65) writeFileSync(join(dir, "roster-pick"), `${stamp} ${Math.floor(rand() * 4)} ${Math.floor(rand() * (fighters + 12)) - 12}\n`);
  else if (r < 0.9) writeFileSync(join(dir, "roster-page"), `${stamp} ${Math.floor(rand() * 30)}\n`);
  else writeFileSync(join(dir, "roster-pick"), `${stamp} ${10 + Math.floor(rand() * 4)} ${Math.floor(rand() * 16)} ${1 + Math.floor(rand() * 3)}\n`);
};
while (Date.now() < end) {
  const state = Array.from({ length: 4 }, (_, p) => {
    if (ports[p] !== "1") return { kind: KINDS.DISCONNECTED, enabled: false, buttons: 0, sx: 0, sy: 0 };
    let buttons = pool[Math.floor(rand() * pool.length)];
    if (rand() < 0.3) buttons |= pool[Math.floor(rand() * pool.length)];
    if (rand() < startBias) buttons |= BUTTONS.START;
    if (buttons) presses++;
    return { kind: KINDS.FILE_DRIVEN_PAD, enabled: true, buttons, sx: Math.round((rand() - 0.5) * 160), sy: Math.round((rand() - 0.5) * 160) };
  });
  if (picks > 0 && rand() < picks / hz) request();
  const data = encodeOSI1({ seq: seq++ & 0xff, mute: 1, ports: state });
  await handle.write(data, 0, data.length, 0);
  await new Promise((r) => setTimeout(r, 1000 / hz));
}
await handle.close();
console.log(`mash-menus: ${seq - 1} writes, ${presses} presses, ${requests} roster requests over ${seconds}s`);
