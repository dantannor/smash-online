import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeOSI1, encodeOSI1, KINDS } from "../shared/protocol.js";

const initializer = fileURLToPath(new URL("./init-input.mjs", import.meta.url));

test("game input initialization preserves an existing sidecar inode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smash-init-input-test-"));
  const inputPath = join(dir, "input.osi1");
  const original = encodeOSI1({ seq: 9, mute: 1, ports: Array.from({ length: 4 }, () => ({ kind: KINDS.DISCONNECTED, enabled: false, buttons: 0, sx: 0, sy: 0 })) });
  await writeFile(inputPath, Buffer.concat([original, Buffer.alloc(12)]), { mode: 0o600 });
  const openHandle = await open(inputPath, "r");
  const inode = (await stat(inputPath)).ino;
  try {
    execFileSync(process.execPath, [initializer], { env: { ...process.env, OPENSMASH_LAUNCHER_INPUT: inputPath }, timeout: 5000 });
    assert.equal((await stat(inputPath)).ino, inode);
    assert.equal((await stat(inputPath)).size, 80);
    const frame = decodeOSI1(await readFile(inputPath));
    const throughOpenHandle = decodeOSI1(await openHandle.readFile());
    for (const value of [frame, throughOpenHandle]) {
      assert.equal(value.seq, 0);
      assert.equal(value.mute, 0);
      assert.deepEqual(value.ports.map((port) => [port.kind, port.enabled, port.buttons, port.sx, port.sy]), [
        [KINDS.GAME_WINDOW_KEYBOARD, 1, 0, 0, 0],
        [KINDS.FILE_DRIVEN_PAD, 1, 0, 0, 0],
        [KINDS.FILE_DRIVEN_PAD, 1, 0, 0, 0],
        [KINDS.FILE_DRIVEN_PAD, 1, 0, 0, 0],
      ]);
    }
  } finally {
    await openHandle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
