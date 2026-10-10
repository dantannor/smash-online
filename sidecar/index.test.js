import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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

test("OSI1 byte layout matches desktop writer for equivalent input", (t) => {
  const refPath = path.join(os.homedir(), "Projects/smash-online-ref/opensmash/desktop/input.cjs");
  if (!fs.existsSync(refPath)) return t.skip("reference input.cjs is not present");
  const require = createRequire(import.meta.url);
  const { createInput } = require(refPath);
  const ref = createInput(fs.mkdtempSync(path.join(os.tmpdir(), "osi1-ref-")));
  t.after(() => { ref.close(); fs.rmSync(path.dirname(ref.file), { recursive: true, force: true }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osi1-ref-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.osi1");
  const sidecar = new Sidecar({ file });
  const ports = [
    [2, 1, 0x8123, -80, 17, 23, -64, 0, 0],
    [3, 1, 0x4567, 80, -80, 4, -9, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [3, 1, 0x0001, -1, 2, -3, 4, 0, 0],
  ];
  ref.begin("test");
  assert.equal(ref.update("test", ports), true);
  const reference = fs.readFileSync(ref.file);
  const expected = encodeOSI1({ seq: 0, mute: 0, ports: ports.map((p) => ({ kind: p[0], enabled: p[1], buttons: p[2], sx: p[3], sy: p[4] })) });
  sidecar.slots = ports.map((p) => ({ kind: p[0], enabled: p[1], buttons: p[2], sx: p[3], sy: p[4] }));
  sidecar.writeSnapshot();
  const actual = fs.readFileSync(file);
  assert.equal(reference.length, 80);
  assert.equal(actual.length, 80);
  assert.equal(actual[4], 0);
  assert.deepEqual(actual.subarray(0, 5), expected.subarray(0, 5));
  for (let i = 0; i < 4; i++) {
    const offset = 8 + 16 * i;
    assert.deepEqual(actual.subarray(offset, offset + 8), reference.subarray(offset, offset + 8));
    assert.deepEqual(actual.subarray(offset + 8, offset + 16), Buffer.alloc(8));
  }
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

test("input timeout neutralizes and disables within 500ms", async (t) => {
  const { file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(2, "conn-timeout", host);
  sidecar.input(2, "conn-timeout", { seq: 1, t: 1, buttons: 8, sx: 5, sy: 6 }, host);
  await sleep(600);
  assert.deepEqual(decodeOSI1(fs.readFileSync(file)).ports[1], { kind: 0, enabled: 0, buttons: 0, sx: 0, sy: 0 });
  assert.ok(host.messages.some((message) => message.type === "slot:disconnected" && message.port === 2));
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

test("atomic snapshot replacement never exposes partial contents", async (t) => {
  const { dir, file } = fixture(t);
  const sidecar = new Sidecar({ file }).start();
  t.after(() => sidecar.close());
  const host = client();
  sidecar.connect(4, "atomic", host);
  for (let i = 0; i < 100; i++) {
    sidecar.input(4, "atomic", { seq: i, t: i, buttons: i, sx: i % 80, sy: -(i % 80) }, host);
    const data = fs.readFileSync(file);
    assert.equal(data.length, 80);
    assert.equal(data.toString("ascii", 0, 4), "OSI1");
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
