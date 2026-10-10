import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { decodeOSI1 } from "../shared/protocol.js";
import { startMockRuntime } from "./mocks/runtime.js";

const timeoutMs = 60_000;
const realMode = process.env.SMASH_E2E_REAL === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;

async function waitFor(fn, timeout = 7000, interval = 15) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(`condition not met within ${timeout}ms`);
}

async function ephemeralPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRealProcesses(osiPath) {
  for (const file of ["server/index.js", "sidecar/index.js", "host/index.html", "guest/index.html"]) {
    await readFile(path.join(root, file));
  }
  const [serverPort, sidecarPort] = await Promise.all([ephemeralPort(), ephemeralPort()]);
  const origin = `http://127.0.0.1:${serverPort}`;
  const children = [
    spawn(process.execPath, ["server/index.js"], { cwd: root, env: { ...process.env, PORT: String(serverPort) }, stdio: "ignore" }),
    spawn(process.execPath, ["sidecar/index.js", "--port", String(sidecarPort)], { cwd: root, env: { ...process.env, OPENSMASH_LAUNCHER_INPUT: osiPath }, stdio: "ignore" }),
  ];
  try {
    await waitFor(async () => {
      try { return (await fetch(`${origin}/healthz`)).ok; } catch { return false; }
    }, 8000);
    return { origin, sidecarUrl: `ws://127.0.0.1:${sidecarPort}`, stop: async () => { for (const child of children) child.kill("SIGTERM"); await Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve)))); } };
  } catch (error) {
    children.forEach((child) => child.kill("SIGTERM"));
    throw error;
  }
}

async function runScenario(t) {
  const temp = await mkdtemp(path.join(tmpdir(), "smash-e2e-"));
  const osiPath = path.join(temp, "input.osi1");
  await writeFile(osiPath, Buffer.alloc(80));
  let runtime; let real;
  if (realMode) real = await startRealProcesses(osiPath);
  else runtime = await startMockRuntime();
  const origin = realMode ? real.origin : runtime.origin;
  let browser; let context; let profileDir;
  const guests = [];
  const latencies = [];
  const result = { mode: realMode ? "real" : "mock", startedAt: new Date().toISOString(), latencyMs: {}, checks: {} };
  try {
    const create = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(create.status, realMode ? 201 : 200, "room creation succeeds");
    const roomInfo = await create.json();
    const hostUrl = new URL(roomInfo.hostUrl);
    hostUrl.searchParams.set("source", "canvas");
    if (realMode) {
      profileDir = await mkdtemp("/tmp/smash-chromium-profile-");
      context = await chromium.launchPersistentContext(profileDir, { headless: true });
    } else {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
    }
    const host = await context.newPage();
    if (realMode) await context.addInitScript(({ room, roomToken, sidecarUrl }) => { window.__SMASH_E2E_ROOM__ = { room, roomToken }; window.__SMASH_E2E_SIDECAR_URL__ = sidecarUrl; }, { room: roomInfo.room, roomToken: roomInfo.roomToken, sidecarUrl: real.sidecarUrl });
    await host.goto(hostUrl.toString());
    await host.waitForFunction(() => typeof window.__smashHostStats === "function", null, { timeout: 10000 });
    await host.waitForFunction(async () => (await window.__smashHostStats())?.frame > 10, null, { timeout: 10000 });

    const slotUrls = roomInfo.slots.sort((a, b) => a.port - b.port).map((slot) => ({ port: slot.port, url: slot.guestUrl }));
    assert.deepEqual(slotUrls.map((slot) => slot.port), [2, 3, 4]);
    for (const slot of slotUrls) {
      const page = await context.newPage();
      guests.push({ ...slot, page });
      await page.goto(slot.url, { timeout: 10000 });
      try {
        await page.waitForFunction((useRealPage) => useRealPage ? window.__smashGuest?.state.connection === "Connected" : window.__smashGuest?.state.connected === true, realMode, { timeout: 8000 });
      } catch (error) {
        const guestState = await page.evaluate(() => ({ state: window.__smashGuest?.stats(), hint: document.querySelector("#hint")?.textContent })).catch(() => null);
        const hostState = await host.evaluate(() => window.__smashHostStats()).catch(() => null);
        throw new Error(`${error.message}; guest=${JSON.stringify(guestState)}; host=${JSON.stringify(hostState)}`);
      }
    }

    for (const guest of guests) {
      const epochBase = await guest.page.evaluate(() => performance.timeOrigin);
      for (let sample = 0; sample < 5; sample++) {
        const input = { buttons: 0x8000 >>> (guest.port - 2), sx: guest.port * 7 + sample, sy: -guest.port * 3 - sample };
        const sent = await guest.page.evaluate((value) => window.__smashGuest.setVirtualInput(value), input);
        const receipt = await waitFor(async () => {
          if (realMode) {
            const bytes = await readFile(osiPath);
            const packet = decodeOSI1(bytes).ports[guest.port - 1];
            return packet.enabled && packet.buttons === input.buttons && packet.sx === input.sx && packet.sy === input.sy ? { receivedAt: Date.now() } : false;
          }
          const state = await fetch(`${origin}/mock/state`).then((response) => response.json());
          return state.receiptTimes.find((entry) => entry.port === guest.port && entry.t === sent.t) ?? false;
        }, 2500);
        const latency = realMode ? receipt.receivedAt - (epochBase + sent.t) : receipt.receivedAt - (epochBase + sent.t);
        latencies.push(Math.max(0, latency));
        if (realMode) {
          const packets = decodeOSI1(await readFile(osiPath)).ports;
          const packet = packets[guest.port - 1];
          assert.equal(packet.buttons, input.buttons, `P${guest.port} receives its guest buttons`);
          assert.ok(packets.every((entry, index) => index === guest.port - 1 || entry.buttons !== input.buttons || entry.sx !== input.sx), "input does not leak to another port");
        } else {
          const state = await fetch(`${origin}/mock/state`).then((response) => response.json());
          const record = state.ports[guest.port - 1];
          assert.equal(record.enabled, 1, `P${guest.port} remains enabled`);
          assert.equal(record.buttons, input.buttons, `P${guest.port} receives its guest buttons`);
          assert.equal(record.sx, input.sx, `P${guest.port} receives its guest X axis`);
          assert.ok(state.ports.every((entry, index) => index === guest.port - 1 || entry.buttons !== input.buttons || entry.sx !== input.sx), "input does not leak to another port");
        }
      }
    }
    assert.ok(Math.max(...latencies) < 100, `input latency max ${Math.max(...latencies).toFixed(1)}ms must be below 100ms`);
    result.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies), samples: latencies.length };
    result.checks.inputRouting = "passed";

    const reconnect = guests[1];
    await reconnect.page.close();
    await waitFor(async () => {
      const ports = realMode ? decodeOSI1(await readFile(osiPath)).ports : (await fetch(`${origin}/mock/state`).then((response) => response.json())).ports;
      const port = ports[reconnect.port - 1];
      return port.enabled === 0 && port.kind === 0;
    }, 500, 20);
    result.checks.disconnectNeutralization = "passed";
    const reopened = await context.newPage();
    await reopened.goto(reconnect.url);
    await reopened.waitForFunction((useRealPage) => useRealPage ? window.__smashGuest?.state.connection === "Connected" : window.__smashGuest?.state.connected === true, realMode, { timeout: 12000 });
    const reopenInput = { buttons: 0x4000, sx: -31, sy: 22 };
    const sent = await reopened.evaluate((value) => window.__smashGuest.setVirtualInput(value), reopenInput);
    await waitFor(async () => {
      if (realMode) {
        const port = decodeOSI1(await readFile(osiPath)).ports[reconnect.port - 1];
        return port.enabled === 1 && port.buttons === reopenInput.buttons;
      }
      const state = await fetch(`${origin}/mock/state`).then((response) => response.json());
      const record = state.ports[reconnect.port - 1];
      return state.receiptTimes.some((entry) => entry.port === reconnect.port && entry.t === sent.t) && record.enabled === 1 && record.buttons === reopenInput.buttons && record.sx === reopenInput.sx;
    }, 3000);
    assert.equal((await reopened.evaluate(() => window.__smashGuest.state.port)), reconnect.port, "same link restores its assigned slot");
    result.checks.reconnectSameSlot = "passed";
    await reopened.close();
    result.finishedAt = new Date().toISOString();
    const reports = path.join(root, "harness/reports");
    await mkdir(reports, { recursive: true });
    await writeFile(path.join(reports, `e2e-${Date.now()}.json`), `${JSON.stringify(result, null, 2)}\n`);
    if (!realMode) await writeFile(path.join(reports, "e2e-sample.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await Promise.all(guests.map(({ page }) => page.close().catch(() => {})));
    await context?.close();
    await browser?.close();
    await runtime?.close();
    await real?.stop();
    await rm(temp, { recursive: true, force: true });
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("host and three guests route input, neutralize disconnects, and reconnect", { timeout: timeoutMs }, async (t) => {
  const result = await runScenario(t);
  assert.equal(result.checks.inputRouting, "passed");
  assert.equal(result.checks.disconnectNeutralization, "passed");
  assert.equal(result.checks.reconnectSameSlot, "passed");
  console.log(`E2E ${result.mode}: input p50=${result.latencyMs.p50.toFixed(1)}ms p95=${result.latencyMs.p95.toFixed(1)}ms max=${result.latencyMs.max.toFixed(1)}ms (${result.latencyMs.samples} samples)`);
});
