#!/usr/bin/env node
import { open, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { encodeOSI1, KINDS } from "../shared/protocol.js";

const DIRECTIONS = [
  { port: 0, name: "P1", direction: "up", sx: 0, sy: 80 },
  { port: 1, name: "P2", direction: "right", sx: 80, sy: 0 },
  { port: 2, name: "P3", direction: "down", sx: 0, sy: -80 },
  { port: 3, name: "P4", direction: "left", sx: -80, sy: 0 },
];
let sequence = 0;
const inputHandles = new Map();

function parseArgs(args) {
  const options = { input: "/tmp/smash-online-input.osi1", output: new URL("./proof/", import.meta.url).pathname, holdMs: 1200 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pid") options.pid = Number(args[++i]);
    else if (args[i] === "--input") options.input = resolve(args[++i]);
    else if (args[i] === "--output") options.output = resolve(args[++i]);
    else if (args[i] === "--hold-ms") options.holdMs = Number(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isInteger(options.pid) || options.pid <= 0) throw new Error("--pid must be the BattleShip process id; the window is resolved fresh for every capture");
  if (!Number.isInteger(options.holdMs) || options.holdMs < 1000) throw new Error("--hold-ms must be at least 1000ms");
  return options;
}

function portsFor(activePort) {
  return DIRECTIONS.map(({ port, sx, sy }) => ({
    kind: KINDS.FILE_DRIVEN_PAD,
    enabled: true,
    buttons: 0,
    sx: port === activePort ? sx : 0,
    sy: port === activePort ? sy : 0,
  }));
}

async function writeOSIFrame(path, frame) {
  // The native reader keeps this inode open, so update it in place, never rename over it.
  let handle = inputHandles.get(path);
  if (!handle) {
    try {
      handle = await open(path, "r+");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      handle = await open(path, "w+", 0o600);
    }
    inputHandles.set(path, handle);
  }
  const bytes = encodeOSI1(frame);
  const { bytesWritten } = await handle.write(bytes, 0, bytes.length, 0);
  if (bytesWritten !== bytes.length) throw new Error(`Wrote ${bytesWritten} of ${bytes.length} OSI1 bytes`);
}

async function closeOSIWriters() {
  await Promise.all([...inputHandles.values()].map((handle) => handle.close()));
  inputHandles.clear();
}

function resolveCurrentWindow(pid) {
  const helper = new URL("./window-id.swift", import.meta.url).pathname;
  const details = execFileSync("swift", [helper, String(pid)], { encoding: "utf8" });
  const window = JSON.parse(details);
  if (!Number.isInteger(window.windowId) || !Array.isArray(window.bounds) || window.bounds.length !== 4) {
    throw new Error(`Window helper returned invalid details: ${details}`);
  }
  return window;
}

function captureCurrentWindow(window, screenshot, pid) {
  const sck = `${process.env.HOME}/Projects/smash-online-build/bin/sck-capture`;
  try {
    execFileSync(sck, [String(pid), screenshot], { stdio: "pipe" });
    return { captureMethod: "ScreenCaptureKit", captureError: null };
  } catch (sckError) {
    try {
      execFileSync("screencapture", ["-l", String(window.windowId), "-x", screenshot], { stdio: "pipe" });
      return { captureMethod: "screencapture-window-id", captureError: sckError.stderr?.toString().trim() || sckError.message };
    } catch (windowCaptureError) {
      throw new Error(`ScreenCaptureKit and screencapture -l failed for fresh game window ${window.windowId}: ${windowCaptureError.stderr?.toString().trim() || windowCaptureError.message}`);
    }
  }
}

async function driveAndCapture({ input, pid, output, holdMs }, entry, index) {
  const endAt = Date.now() + holdMs;
  let writes = 0;
  while (Date.now() < endAt) {
    const start = Date.now();
    await writeOSIFrame(input, { seq: sequence++ & 0xff, mute: 0, ports: portsFor(entry.port) });
    writes++;
    await delay(Math.max(0, 16 - (Date.now() - start)));
  }
  await delay(250);
  const screenshot = resolve(output, `${String(index + 1).padStart(2, "0")}-${entry.name.toLowerCase()}-${entry.direction}.png`);
  const window = resolveCurrentWindow(pid);
  const capture = captureCurrentWindow(window, screenshot, pid);
  return {
    screenshot,
    windowId: window.windowId,
    windowBounds: window.bounds,
    port: entry.name,
    portIndex: entry.port,
    direction: entry.direction,
    expectedMovement: `${entry.name} character-select cursor ${entry.direction}`,
    writes,
    inputKind: KINDS.FILE_DRIVEN_PAD,
    enabled: true,
    captureMethod: capture.captureMethod,
    captureError: capture.captureError,
  };
}

export { DIRECTIONS, portsFor, writeOSIFrame, closeOSIWriters, resolveCurrentWindow, captureCurrentWindow, driveAndCapture };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await mkdir(options.output, { recursive: true });
    const screenshots = [];
    for (let i = 0; i < DIRECTIONS.length; i++) {
      screenshots.push(await driveAndCapture(options, DIRECTIONS[i], i));
    }
    await writeOSIFrame(options.input, {
      seq: sequence++ & 0xff,
      mute: 0,
      ports: DIRECTIONS.map(({ port }) => ({
        kind: port === 0 ? KINDS.GAME_WINDOW_KEYBOARD : KINDS.FILE_DRIVEN_PAD,
        enabled: true,
        buttons: 0,
        sx: 0,
        sy: 0,
      })),
    });
    const report = {
      generatedAt: new Date().toISOString(),
      processId: options.pid,
      inputFile: options.input,
      minimumPulseIntervalMs: 16,
      capturePolicy: "ScreenCaptureKit desktop-independent window capture first; fresh screencapture -l fallback; never capture screen regions",
      windowResolution: "fresh CGWindowList query before each screenshot, matching BattleShip owner, BattleShip (Metal), layer 0, largest bounds",
      screenshots,
    };
    await closeOSIWriters();
    const reportPath = resolve(options.output, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(reportPath);
  } catch (error) {
    console.error(error?.stderr?.toString().trim() || error?.message || error);
    process.exitCode = 1;
  }
}
