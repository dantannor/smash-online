import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { Sidecar, createSidecarServer } from "./index.js";
import { decodeOSI1, encodeOSI1, KINDS } from "../shared/protocol.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smash-sidecar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "input.osi1") };
}
const client = () => ({ messages: [], sendJson(value) { this.messages.push(value); } });

test("sidecar snapshots match the shared OSI1 encoder", (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const ports = [
    { kind: 2, enabled: 1, buttons: 0x8123, sx: -80, sy: 17 },
    { kind: 3, enabled: 1, buttons: 0x4567, sx: 80, sy: -80 },
    { kind: 0, enabled: 0, buttons: 0, sx: 0, sy: 0 },
    { kind: 3, enabled: 1, buttons: 1, sx: -1, sy: 2 },
  ];
  sidecar.slots = ports;
  sidecar.writeSnapshot();
  const actual = fs.readFileSync(file);
  assert.deepEqual(actual, Buffer.from(encodeOSI1({ seq: 1, mute: 0, ports })));
  for (let i = 0; i < 4; i++) assert.deepEqual(actual.subarray(8 + 16 * i + 8, 8 + 16 * i + 16), Buffer.alloc(8));
});

test("refresh writes a fresh complete snapshot at 100ms cadence", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const first = fs.readFileSync(file);
  await sleep(235);
  const second = fs.readFileSync(file);
  assert.equal(second.length, 80);
  assert.notEqual(second[5], first[5]);
  const stat = fs.statSync(file);
  assert.ok(Date.now() - stat.mtimeMs < 100, "file should have been rewritten within one cadence interval");
});

test("disconnect neutralizes and disables the slot immediately", (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(2, "conn-a", host);
  sidecar.input(2, "conn-a", { seq: 1, t: 1, buttons: 0xffff, sx: 80, sy: -80 }, host);
  sidecar.disconnect(2, "conn-a", host);
  const port = decodeOSI1(fs.readFileSync(file)).ports[1];
  assert.deepEqual(port, { kind: 0, enabled: 0, buttons: 0, sx: 0, sy: 0 });
});

test("input timeout neutralizes but keeps the slot connected, then resumes", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(2, "conn-timeout", host);
  sidecar.input(2, "conn-timeout", { seq: 1, t: 1, buttons: 8, sx: 5, sy: 6 }, host);
  await sleep(600);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[1], { kind: 3, enabled: 1, buttons: 0, sx: 0, sy: 0 });
  assert.equal(host.messages.some((message) => message.type === "slot:disconnected" && message.port === 2), false);
  sidecar.input(2, "conn-timeout", { seq: 2, t: 601, buttons: 16, sx: -4, sy: 7 }, host);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[1], { kind: 3, enabled: 1, buttons: 16, sx: -4, sy: 7 });
});

test("a stall shorter than inputTimeoutMs holds the last input instead of dropping to neutral", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file, inputTimeoutMs: 1200 }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(2, "conn-hold", host);
  sidecar.input(2, "conn-hold", { seq: 1, t: 1, buttons: 0x4000, sx: 80, sy: 0 }, host);
  await sleep(900); // longer than the 500 ms contract default, shorter than the configured timeout
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[1], { kind: 3, enabled: 1, buttons: 0x4000, sx: 80, sy: 0 });
  await sleep(500);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[1], { kind: 3, enabled: 1, buttons: 0, sx: 0, sy: 0 });
});

test("replacement connection invalidates old ID and starts neutral", (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(3, "old", host);
  sidecar.input(3, "old", { seq: 1, t: 1, buttons: 0x80, sx: 2, sy: 3 }, host);
  sidecar.connect(3, "new", host);
  sidecar.input(3, "old", { seq: 2, t: 2, buttons: 2, sx: 0, sy: 0 }, host);
  assert.equal(host.messages.at(-1).code, "stale_connection");
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[2], { kind: 3, enabled: 1, buttons: 0, sx: 0, sy: 0 });
  sidecar.input(3, "new", { seq: 0, t: 3, buttons: 1, sx: -1, sy: 1 }, host);
  assert.equal(decodeOSI1(fs.readFileSync(file)).ports[2].buttons, 1);
});

test("rejects invalid ports, malformed inputs, stale IDs, and non-monotonic seq", (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(5, "bad", host);
  sidecar.connect(1, "good", host);
  sidecar.input(1, "stale", { seq: 1, t: 1, buttons: 1, sx: 0, sy: 0 }, host);
  sidecar.input(1, "good", { seq: 1, t: 1, buttons: 1, sx: 0, sy: 0 }, host);
  sidecar.input(1, "good", { seq: 1, t: 2, buttons: 2, sx: 0, sy: 0 }, host);
  sidecar.input(1, "good", { seq: 2, t: 3, buttons: NaN, sx: 0, sy: 0 }, host);
  assert.deepEqual(host.messages.filter((message) => message.type === "error").map((message) => message.code), ["invalid_slot", "stale_connection", "non_monotonic_seq", "invalid_input"]);
});

test("in-place snapshot writes preserve the file identity and complete 80-byte contents", async (t) => {
  const { dir, file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const originalInode = fs.statSync(file).ino;
  const host = client();
  sidecar.connect(4, "in-place", host);
  for (let i = 0; i < 100; i++) {
    sidecar.input(4, "in-place", { seq: i, t: i, buttons: i, sx: i % 80, sy: -(i % 80) }, host);
    const data = fs.readFileSync(file);
    assert.equal(data.length, 80);
    assert.equal(data.toString("ascii", 0, 4), "OSI1");
    assert.equal(fs.statSync(file).ino, originalInode);
  }
  assert.deepEqual(fs.readdirSync(dir), ["input.osi1"]);
});

test("loopback WebSocket emits ready and accepts P1 input", async (t) => {
  const { dir, file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  const server = createSidecarServer(sidecar, { port: 0 });
  const address = await server.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    if (ws.readyState < WebSocket.CLOSING) await new Promise((resolve) => { ws.once("close", resolve); ws.close(); });
    await server.close();
    sidecar.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  for (let i = 0; i < 20 && !messages.some((message) => message.type === "ready"); i++) await sleep(5);
  assert.ok(messages.some((message) => message.type === "ready"));
  ws.send(JSON.stringify({ type: "slot:connect", port: 1, connectionId: "host-p1" }));
  ws.send(JSON.stringify({ type: "slot:input", port: 1, connectionId: "host-p1", input: { seq: 1, t: 0, buttons: 9, sx: 2, sy: -3 } }));
  for (let i = 0; i < 20 && decodeOSI1(fs.readFileSync(file)).ports[0].buttons !== 9; i++) await sleep(5);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[0], { kind: 3, enabled: 1, buttons: 9, sx: 2, sy: -3 });
});

test("pad-helper JSON lines drive P1 as kind 3", async (t) => {
  const { dir, file } = fixture(t);
  const sidecar = new Sidecar({ file, p1: "pad-helper" }).start();
  t.after(() => { sidecar.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  sidecar.startHelper(`${process.execPath} -e 'console.log(JSON.stringify({buttons:4660,sx:-12,sy:34}))'`);
  for (let i = 0; i < 20 && decodeOSI1(fs.readFileSync(file)).ports[0].buttons !== 4660; i++) await sleep(10);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[0], { kind: KINDS.FILE_DRIVEN_PAD, enabled: 1, buttons: 4660, sx: -12, sy: 34 });
});

test("clean shutdown writes a final neutral snapshot", (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  const host = client();
  sidecar.connect(2, "close", host);
  sidecar.input(2, "close", { seq: 1, t: 1, buttons: 1, sx: 1, sy: 1 }, host);
  sidecar.close();
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports, Array.from({ length: 4 }, () => ({ kind: 0, enabled: 0, buttons: 0, sx: 0, sy: 0 })));
});

test("mute byte is 0 by default, 1 with mute, and toggles over the WebSocket", async (t) => {
  const { file } = fixture(t);
  const plain = new Sidecar({ file }).start();
  assert.equal(fs.readFileSync(file)[4], 0);
  plain.close();
  const sidecar = new Sidecar({ file, mute: true }).start();
  t.after(() => sidecar.close());
  assert.equal(fs.readFileSync(file)[4], 1);
  const server = createSidecarServer(sidecar, { port: 0 });
  const address = await server.listen();
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise((resolve) => ws.once("message", resolve));
  ws.send(JSON.stringify({ type: "mute", value: false }));
  await sleep(50);
  assert.equal(decodeOSI1(fs.readFileSync(file)).mute, 0);
  ws.close();
});

test("SIGTERM exits promptly with a neutral final packet while a host websocket is connected", async (t) => {
  const { file } = fixture(t);
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "index.js"), "--file", file, "--port", String(free), "--mute"], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { out += chunk; const m = out.match(/ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
    child.once("exit", () => reject(new Error("sidecar exited early")));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once("message", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "slot:connect", port: 2, connectionId: "c1" }));
  await sleep(250);
  assert.equal(decodeOSI1(fs.readFileSync(file)).ports[1].enabled, 1);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const started = Date.now();
  child.kill("SIGTERM");
  const result = await Promise.race([exited, sleep(1500).then(() => "timeout")]);
  assert.notEqual(result, "timeout", "sidecar ignored SIGTERM");
  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(Date.now() - started < 1500);
  const final = decodeOSI1(fs.readFileSync(file));
  for (const p of final.ports) {
    assert.deepEqual(p, { kind: KINDS.DISCONNECTED, enabled: 0, buttons: 0, sx: 0, sy: 0 });
  }
});

test("roster:page writes a new '<seq> <page>' request for the game and validates the page", (t) => {
  const { file } = fixture(t);
  const pageFile = file + ".page";
  const sidecar = new Sidecar({ file, rosterPageFile: pageFile }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.requestRosterPage(7, host);
  const [seq, page] = fs.readFileSync(pageFile, "utf8").trim().split(" ").map(Number);
  assert.equal(page, 7); assert.ok(seq > 0);
  sidecar.requestRosterPage(-1, host); sidecar.requestRosterPage(1.5, host);
  assert.equal(host.messages.filter((m) => m.code === "invalid_page").length, 2);
  assert.equal(fs.readFileSync(pageFile, "utf8").trim().split(" ")[1], "7");
  const bare = new Sidecar({ file: file + "2" }).start();
  t.after(() => bare.close());
  bare.requestRosterPage(1, host);
  assert.ok(host.messages.some((m) => m.code === "roster_unavailable"));
});

test("roster:pick writes '<seq> <player> <idx>' for a custom fighter or an original and validates input", (t) => {
  const { file } = fixture(t);
  const pickFile = file + ".pick";
  const sidecar = new Sidecar({ file, rosterPickFile: pickFile }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.requestRosterPick(3, 500, host);
  assert.deepEqual(fs.readFileSync(pickFile, "utf8").trim().split(" ").slice(1), ["2", "500"]);
  sidecar.requestRosterPick(1, -5, host);
  assert.deepEqual(fs.readFileSync(pickFile, "utf8").trim().split(" ").slice(1), ["0", "-5"]);
  sidecar.requestRosterPick(9, 1, host); sidecar.requestRosterPick(1, 5000, host); sidecar.requestRosterPick(1, 1.5, host);
  assert.equal(host.messages.filter((m) => m.code === "invalid_pick").length, 3);
});

test("roster:solo writes '<seq> <10 + player> <connected mask> <cpus>' and validates input", (t) => {
  const { file } = fixture(t);
  const pickFile = file + ".pick";
  const sidecar = new Sidecar({ file, rosterPickFile: pickFile }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.requestSolo(1, 2, host);
  assert.deepEqual(fs.readFileSync(pickFile, "utf8").trim().split(" ").slice(1), ["10", "1", "2"]);
  sidecar.requestSolo(3, 3, host);
  assert.deepEqual(fs.readFileSync(pickFile, "utf8").trim().split(" ").slice(1), ["12", "4", "3"]);
  sidecar.requestSolo(9, 1, host); sidecar.requestSolo(1, 0, host); sidecar.requestSolo(1, 4, host);
  assert.equal(host.messages.filter((m) => m.code === "invalid_solo").length, 3);
});

test("match:end writes '<seq> 30 <player - 1> 0' and reports match:ended only once the game acks that request", (t) => {
  const { file } = fixture(t);
  const pickFile = file + ".pick";
  let clock = 5_000_000;
  const sidecar = new Sidecar({ file, rosterPickFile: pickFile, now: () => clock }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.requestEndMatch(3, host);
  assert.equal(fs.readFileSync(pickFile, "utf8"), "5000000 30 2 0\n");
  sidecar.checkEndAck();
  assert.equal(host.messages.filter((m) => m.type === "match:ended").length, 0, "no ack: the game was not in a match, so stay silent");
  fs.writeFileSync(pickFile + ".ack", "4999000 0\n"); // an older request's ack does not count
  sidecar.checkEndAck();
  assert.equal(host.messages.filter((m) => m.type === "match:ended").length, 0);
  fs.writeFileSync(pickFile + ".ack", "5000000 2\n");
  sidecar.checkEndAck();
  assert.deepEqual(host.messages.filter((m) => m.type === "match:ended"), [{ type: "match:ended", port: 3 }]);
  sidecar.checkEndAck();
  assert.equal(host.messages.filter((m) => m.type === "match:ended").length, 1, "reported once");
  sidecar.requestEndMatch(1, host); clock += 4000; sidecar.checkEndAck();
  assert.equal(sidecar.pendingEnd, null, "an unacknowledged request expires");
  sidecar.requestEndMatch(9, host);
  assert.ok(host.messages.some((m) => m.code === "invalid_end"));
});

test("a first guest arriving after an idle spell writes the intro request; a second guest or a quick return does not", (t) => {
  const { file } = fixture(t);
  const pickFile = file + ".pick";
  let clock = 1_000_000;
  const sidecar = new Sidecar({ file, rosterPickFile: pickFile, introIdleMs: 60_000, now: () => clock }).start();
  t.after(() => sidecar.close());
  const host = client();
  clock += 5_000;
  sidecar.connect(2, "a", host); // only 5 s since the sidecar started: no request
  assert.equal(fs.existsSync(pickFile), false);
  sidecar.disconnect(2, "a", host);
  clock += 120_000;
  sidecar.connect(2, "b", host);
  assert.deepEqual(fs.readFileSync(pickFile, "utf8").trim().split(" ").slice(1), ["20", "0", "0"]);
  fs.rmSync(pickFile);
  clock += 120_000;
  sidecar.connect(3, "c", host); // someone is already connected: never
  assert.equal(fs.existsSync(pickFile), false);
});

test("a press released within the same game frame stays in the file for a full frame, then releases", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  const buttons = () => decodeOSI1(fs.readFileSync(file)).ports[1].buttons;
  sidecar.connect(2, "conn-tap", host);
  // Network jitter bunches a press and its release into one burst; the game samples the file once per 16.7 ms frame.
  sidecar.input(2, "conn-tap", { seq: 1, t: 1, buttons: 0x8000, sx: 0, sy: 0 }, host);
  sidecar.input(2, "conn-tap", { seq: 2, t: 2, buttons: 0, sx: 0, sy: 0 }, host);
  assert.equal(buttons(), 0x8000, "a sampler running right after the burst must still see the press");
  await sleep(40);
  assert.equal(buttons(), 0, "the release must still arrive");
  // A release that comes after a normal hold is not delayed.
  sidecar.input(2, "conn-tap", { seq: 3, t: 3, buttons: 0x4000, sx: 0, sy: 0 }, host);
  await sleep(40);
  sidecar.input(2, "conn-tap", { seq: 4, t: 4, buttons: 0, sx: 0, sy: 0 }, host);
  assert.equal(buttons(), 0);
  // Another port's presses are untouched by this port's hold.
  sidecar.connect(3, "conn-other", host);
  sidecar.input(3, "conn-other", { seq: 1, t: 1, buttons: 1, sx: 0, sy: 0 }, host);
  sidecar.input(3, "conn-other", { seq: 2, t: 2, buttons: 0, sx: 5, sy: 0 }, host);
  assert.equal(decodeOSI1(fs.readFileSync(file)).ports[2].sx, 5, "stick still follows the latest message");
});
