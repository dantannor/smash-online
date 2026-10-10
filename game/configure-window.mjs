import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const path = process.argv[2];
if (!path) throw new Error("usage: configure-window.mjs <BattleShip.cfg.json>");
const config = JSON.parse(await readFile(path, "utf8"));
config.Window ??= {};
config.Window.Fullscreen ??= {};
config.Window.Fullscreen.Enabled = false;
config.Window.Width = 640;
config.Window.Height = 480;
config.Window.PositionX = 100;
config.Window.PositionY = 100;
const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
await rename(temporary, path);
