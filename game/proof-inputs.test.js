import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOSI1, KINDS } from "../shared/protocol.js";
import { DIRECTIONS, writeOSIFrame, closeOSIWriters, portsFor } from "./proof-inputs.mjs";

test("input proof drives each file-driven port independently", () => {
  assert.deepEqual(DIRECTIONS.map(({ port }) => port), [0, 1, 2, 3]);
  for (const { port, sx, sy } of DIRECTIONS) {
    const inputs = portsFor(port);
    assert.equal(inputs.length, 4);
    assert.deepEqual(inputs.map((input) => input.kind), Array(4).fill(KINDS.FILE_DRIVEN_PAD));
    assert.deepEqual(inputs.map((input) => input.enabled), Array(4).fill(true));
    assert.deepEqual(inputs.map(({ sx, sy }) => [sx, sy]), Array.from({ length: 4 }, (_, i) => i === port ? [sx, sy] : [0, 0]));
  }
});

test("OSI1 proof writer uses the shared encoder and writes complete frames in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smash-online-osi1-test-"));
  const path = join(dir, "inputs.osi1");
  try {
    await writeOSIFrame(path, { seq: 42, mute: 0, ports: portsFor(2) });
    const inode = (await stat(path)).ino;
    await writeOSIFrame(path, { seq: 43, mute: 0, ports: portsFor(0) });
    const bytes = await readFile(path);
    const frame = decodeOSI1(bytes);
    assert.equal(bytes.length, 80);
    assert.equal((await stat(path)).ino, inode, "writes must preserve the inode held by the game");
    assert.equal(frame.seq, 43);
    assert.equal(frame.mute, 0);
    assert.deepEqual(frame.ports.map(({ sx, sy }) => [sx, sy]), [[0, 80], [0, 0], [0, 0], [0, 0]]);
  } finally {
    await closeOSIWriters();
    await rm(dir, { recursive: true, force: true });
  }
});
