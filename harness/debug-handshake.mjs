import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.SMASH_HANDSHAKE_TIMEOUT_MS || 15_000);
const events = [];
let context;
let server;
let sidecar;
let temp;
let profileDir;

function scrubText(value) {
  return String(value).replace(/([?&](?:token|slot)=)[^&#\s]*/gi, "$1<redacted>");
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of ["token", "slot"]) if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
    return url.toString();
  } catch { return scrubText(value); }
}
function record(event) {
  events.push(event);
  console.log(JSON.stringify(event));
}
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function streamChild(label, child) {
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => record({ source: label, line: scrubText(line) }));
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (line) => record({ source: `${label}:stderr`, line: scrubText(line) }));
  child.once("error", (error) => record({ source: label, event: "spawn-error", message: scrubText(error.message) }));
}
function attachPageLogs(page, label) {
  page.on("console", (message) => record({ source: label, event: "console", level: message.type(), text: scrubText(message.text()) }));
  page.on("pageerror", (error) => record({ source: label, event: "pageerror", message: scrubText(error.message), stack: scrubText(error.stack || "") }));
  page.on("requestfailed", (request) => record({ source: label, event: "requestfailed", method: request.method(), url: safeUrl(request.url()), error: request.failure()?.errorText ?? null }));
  page.on("response", (response) => {
    if (response.status() >= 400) record({ source: label, event: "http-error", status: response.status(), url: safeUrl(response.url()) });
  });
}
async function waitFor(fn, description, ms = timeoutMs) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description} after ${ms}ms`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

let final = { ok: false, phase: "setup", events };
try {
  for (const file of ["server/index.js", "sidecar/index.js", "host/index.html", "guest/index.html", "shared/protocol.js"]) await readFile(path.join(root, file));
  const [serverPort, sidecarPort] = await Promise.all([ephemeralPort(), ephemeralPort()]);
  temp = await mkdtemp(path.join(tmpdir(), "smash-debug-handshake-"));
  profileDir = await mkdtemp("/tmp/smash-debug-chromium-");
  const osiFile = path.join(temp, "input.osi1");
  const serverOrigin = `http://127.0.0.1:${serverPort}`;
  server = spawn(process.execPath, ["server/index.js"], { cwd: root, env: { ...process.env, PORT: String(serverPort), HOST: "127.0.0.1", SMASH_DEBUG: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  sidecar = spawn(process.execPath, ["sidecar/index.js", "--file", osiFile, "--port", String(sidecarPort)], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  streamChild("server", server);
  streamChild("sidecar", sidecar);
  await waitFor(async () => (await fetch(`${serverOrigin}/healthz`).catch(() => null))?.ok, "real server health");

  const roomResponse = await fetch(`${serverOrigin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (roomResponse.status !== 201) throw new Error(`Room creation returned ${roomResponse.status}`);
  const roomInfo = await roomResponse.json();
  const slot = roomInfo.slots.find((candidate) => candidate.port === 2);
  if (!slot) throw new Error("Room response did not include P2");

  context = await chromium.launchPersistentContext(profileDir, { headless: true });
  await context.addInitScript(({ room, roomToken, sidecarUrl }) => {
    window.__SMASH_E2E_ROOM__ = { room, roomToken };
    window.__SMASH_E2E_SIDECAR_URL__ = sidecarUrl;
  }, { room: roomInfo.room, roomToken: roomInfo.roomToken, sidecarUrl: `ws://127.0.0.1:${sidecarPort}` });
  const host = await context.newPage();
  attachPageLogs(host, "host");
  const hostUrl = new URL(roomInfo.hostUrl);
  hostUrl.searchParams.set("source", "canvas");
  final.phase = "host-canvas";
  await host.goto(hostUrl.toString(), { timeout: 10_000 });
  await host.waitForFunction(() => typeof window.__smashHostStats === "function" && window.__smashHostStats().frame > 10, null, { timeout: timeoutMs });

  const guest = await context.newPage();
  attachPageLogs(guest, "guest-P2");
  final.phase = "guest-join";
  await guest.goto(slot.guestUrl, { timeout: 10_000 });
  await guest.waitForFunction(() => window.__smashGuest?.state.connection === "Connected", null, { timeout: timeoutMs });
  final = { ok: true, phase: "connected", guest: await guest.evaluate(() => window.__smashGuest.stats()), host: await host.evaluate(() => window.__smashHostStats()), events };
} catch (error) {
  final = { ...final, ok: false, error: scrubText(error.message), stack: scrubText(error.stack || ""), events };
  if (context) {
    const pages = context.pages();
    final.pages = await Promise.all(pages.map(async (page) => ({ url: safeUrl(page.url()), title: await page.title().catch(() => ""), body: scrubText((await page.locator("body").innerText().catch(() => "")).slice(0, 1000)) })));
  }
} finally {
  await context?.close().catch((error) => record({ source: "cleanup", event: "context-close-error", message: scrubText(error.message) }));
  await stopChild(sidecar);
  await stopChild(server);
  if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

const evidence = path.join(root, "docs/evidence/debug-handshake.json");
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(path.dirname(evidence), { recursive: true }).then(() => writeFile(evidence, `${JSON.stringify(final, null, 2)}\n`)));
if (!final.ok) {
  console.error(JSON.stringify({ ok: false, phase: final.phase, error: final.error, evidence }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, phase: final.phase, guest: final.guest, evidence }));
}
