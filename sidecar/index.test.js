import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("audio source PCM is forwarded to the single host as binary frames", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  const server = createSidecarServer(sidecar, { port: 0 });
  const address = await server.listen();
  const host = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const audio = new WebSocket(`ws://127.0.0.1:${address.port}/?role=audio`);
  t.after(async () => {
    for (const ws of [host, audio]) if (ws.readyState < WebSocket.CLOSING) ws.close();
    await server.close();
    sidecar.close();
  });
  const hostMessages = [];
  host.on("message", (data, isBinary) => hostMessages.push({ data: Buffer.from(data), isBinary }));
  await Promise.all([host, audio].map(ws => new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); })));
  const pcm = Buffer.from(new Float32Array([0.25, -0.25, 0.5, -0.5]).buffer);
  const received = new Promise(resolve => host.once("message", (data, isBinary) => resolve({ data: Buffer.from(data), isBinary })));
  audio.send(pcm);
  const frame = await received;
  assert.equal(frame.isBinary, true);
  assert.deepEqual(frame.data, pcm);
  audio.send(Buffer.from([1, 2, 3]));
  await new Promise(resolve => audio.once("close", resolve));
  assert.ok(hostMessages.some(item => item.data.toString().includes('"type":"ready"')));
});

test("pad-helper JSON lines drive P1 as kind 3", async (t) => {
  const { dir, file } = fixture(t);
  const sidecar = new Sidecar({ file, p1: "pad-helper" }).start();
  t.after(() => { sidecar.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  sidecar.startHelper(`${process.execPath} -e 'console.log(JSON.stringify({buttons:4660,sx:-12,sy:34}))'`);
  for (let i = 0; i < 100 && decodeOSI1(fs.readFileSync(file)).ports[0].buttons !== 4660; i++) await sleep(10);
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
