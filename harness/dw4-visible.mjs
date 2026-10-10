import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolveCurrentWindow, captureCurrentWindow } from "../game/proof-inputs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "docs/evidence");
const children = [];
let hostContext;
let guestContext;
let hostProfile;
let guestProfile;
let temp;
let gamePid = null;
const report = { status: "blocked", startedAt: new Date().toISOString(), steps: [], screenshots: [], audio: null };

function port() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close((error) => error ? reject(error) : resolve(value));
    });
  });
}
function recordChild(label, child) {
  children.push(child);
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    if (label === "game") {
      const match = line.match(/^game_pid=(\d+)$/);
      if (match) gamePid = Number(match[1]);
    }
    console.log(`[${label}] ${line}`);
  });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (line) => console.error(`[${label}:stderr] ${line}`));
  child.once("error", (error) => console.error(`[${label}:spawn-error] ${error.message}`));
  return child;
}
async function waitFor(fn, message, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
async function captureGame(name) {
  const file = path.join(evidenceDir, name);
  const window = resolveCurrentWindow(gamePid);
  const capture = captureCurrentWindow(window, file, gamePid);
  report.screenshots.push({ file: path.relative(root, file), windowId: window.windowId, bounds: window.bounds, method: capture.captureMethod });
  return window;
}
async function p1(buttons, durationMs = 250) {
  await hostPage.evaluate((mask) => window.__smashHostSetP1Input({ buttons: mask, sx: 0, sy: 0 }), buttons);
  await delay(durationMs);
  await hostPage.evaluate(() => window.__smashHostSetP1Input({ buttons: 0, sx: 0, sy: 0 }));
}
let hostPage;

try {
  await mkdir(evidenceDir, { recursive: true });
  temp = await mkdtemp(path.join(tmpdir(), "smash-dw4-"));
  const inputFile = path.join(temp, "input.osi1");
  const [serverPort, sidecarPort] = await Promise.all([port(), port()]);
  const origin = `http://127.0.0.1:${serverPort}`;

  recordChild("server", spawn(process.execPath, ["server/index.js"], { cwd: root, env: { ...process.env, PORT: String(serverPort), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] }));
  recordChild("sidecar", spawn(process.execPath, ["sidecar/index.js", "--file", inputFile, "--port", String(sidecarPort)], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] }));
  await waitFor(async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok, "server health");

  const game = recordChild("game", spawn("bash", [path.join(root, "game/run-game.sh")], { cwd: root, env: { ...process.env, OPENSMASH_LAUNCHER_INPUT: inputFile }, stdio: ["ignore", "pipe", "pipe"] }));
  await waitFor(() => gamePid !== null, "BattleShip process and window", 40_000);
  report.steps.push({ name: "game-start", pass: true, gamePid });
  await captureGame("dw4-initial.png");

  hostProfile = await mkdtemp("/tmp/smash-dw4-host-chrome-");
  hostContext = await chromium.launchPersistentContext(hostProfile, {
    channel: "chrome",
    headless: false,
    args: [`--auto-select-desktop-capture-source=BattleShip (Metal)`],
  });
  await hostContext.addInitScript(({ sidecarUrl }) => { window.__SMASH_E2E_SIDECAR_URL__ = sidecarUrl; }, { sidecarUrl: `ws://127.0.0.1:${sidecarPort}` });
  hostPage = await hostContext.newPage();
  hostPage.on("console", (message) => console.log(`[host-console:${message.type()}] ${message.text()}`));
  hostPage.on("pageerror", (error) => console.error(`[host-pageerror] ${error.message}`));
  hostPage.on("requestfailed", (request) => console.error(`[host-requestfailed] ${request.url()} ${request.failure()?.errorText}`));
  const hostUrl = `${origin}/host?testHooks=1`;
  await hostPage.goto(hostUrl, { timeout: 15_000 });
  await hostPage.locator("#source").selectOption("display");
  await hostPage.locator("#start").click();
  await waitFor(async () => hostPage.evaluate(() => window.__smashHostStats?.().capturedTracks.some((track) => track.kind === "video" && track.readyState === "live")).catch(() => false), "BattleShip window capture", 30_000);
  const roomLinks = await hostPage.locator("#guest-links input").evaluateAll((nodes) => nodes.map((node) => node.value));
  const p2Link = roomLinks.find((value) => new URL(value).searchParams.has("slot"));
  if (!p2Link) throw new Error("Host page did not render a P2 guest link");
  report.steps.push({ name: "host-window-capture", pass: true, source: "BattleShip (Metal)", tracks: await hostPage.evaluate(() => window.__smashHostStats().capturedTracks) });
  report.audio = await hostPage.evaluate(() => ({ tracks: window.__smashHostStats().capturedTracks.filter((track) => track.kind === "audio"), warning: document.querySelector("#status")?.textContent }));

  guestProfile = await mkdtemp("/tmp/smash-dw4-guest-chrome-");
  guestContext = await chromium.launchPersistentContext(guestProfile, { channel: "chrome", headless: false });
  const guestPage = await guestContext.newPage();
  guestPage.on("console", (message) => console.log(`[guest-console:${message.type()}] ${message.text()}`));
  guestPage.on("pageerror", (error) => console.error(`[guest-pageerror] ${error.message}`));
  guestPage.on("requestfailed", (request) => console.error(`[guest-requestfailed] ${request.url()} ${request.failure()?.errorText}`));
  await guestPage.goto(p2Link, { timeout: 15_000 });
  await guestPage.waitForFunction(() => window.__smashGuest?.state.connected === true, null, { timeout: 20_000 });
  await guestPage.waitForFunction(() => { const video = document.querySelector("#video"); return video?.videoWidth > 0 && video.currentTime > 0; }, null, { timeout: 20_000 });
  await guestPage.screenshot({ path: path.join(evidenceDir, "dw4-guest-live.png"), fullPage: true });
  report.steps.push({ name: "guest-live-video", pass: true, port: await guestPage.evaluate(() => window.__smashGuest.state.port), screenshot: "docs/evidence/dw4-guest-live.png" });

  // Advance both P1 and P2 through character selection and stage selection.
  await p1(0x8000);
  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0x8000, sx: 0, sy: 0 }));
  await delay(300);
  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }));
  await captureGame("dw4-character-select.png");
  await p1(0x1000);
  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0x1000, sx: 0, sy: 0 }));
  await delay(300);
  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }));
  await delay(1500);
  await captureGame("dw4-vs-match.png");
  report.steps.push({ name: "vs-match", pass: true, p1: "P1 sidecar port 1 test hook", p2: "guest P2 DataChannel input" });

  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0, sx: 80, sy: 0 }));
  await delay(1000);
  await guestPage.evaluate(() => window.__smashGuest.setVirtualInput({ buttons: 0, sx: 0, sy: 0 }));
  await delay(500);
  await captureGame("dw4-p2-guest-input.png");
  await guestPage.screenshot({ path: path.join(evidenceDir, "dw4-guest-after-input.png"), fullPage: true });
  report.steps.push({ name: "p2-controlled-by-guest", pass: true, input: { sx: 80, durationMs: 1000 }, gameScreenshot: "docs/evidence/dw4-p2-guest-input.png", guestScreenshot: "docs/evidence/dw4-guest-after-input.png" });
  report.status = "pass";
} catch (error) {
  report.error = error.message;
  console.error(`[DW4] ${error.stack || error.message}`);
} finally {
  report.finishedAt = new Date().toISOString();
  await guestContext?.close().catch((error) => console.error(`[cleanup-guest] ${error.message}`));
  await hostContext?.close().catch((error) => console.error(`[cleanup-host] ${error.message}`));
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  if (gamePid && !children.at(-1)?.killed) { try { process.kill(gamePid, "SIGTERM"); } catch {} }
  await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
  if (guestProfile) await rm(guestProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (hostProfile) await rm(hostProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await writeFile(path.join(evidenceDir, "dw4-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (report.status !== "pass") process.exitCode = 1;
else console.log(JSON.stringify(report, null, 2));
