import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const path = process.argv[2];
if (!path) throw new Error("usage: configure-window.mjs <BattleShip.cfg.json>");
const config = JSON.parse(await readFile(path, "utf8"));
config.Window ??= {};
config.Window.Fullscreen ??= {};
config.Window.Fullscreen.Enabled = false;
if (process.env.SMASH_AUDIO_BACKEND) config.Window.AudioBackend = process.env.SMASH_AUDIO_BACKEND; // the Linux first-run default is "null" (silent)
config.Window.Width = Number(process.env.SMASH_WINDOW_W ?? 640);
config.Window.Height = Number(process.env.SMASH_WINDOW_H ?? 480);
config.Window.PositionX = Number(process.env.SMASH_WINDOW_X ?? 100);
config.Window.PositionY = Number(process.env.SMASH_WINDOW_Y ?? 100);
const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
await rename(temporary, path);
