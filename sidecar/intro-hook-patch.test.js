import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const patch = fs.readFileSync(new URL("../cloud/vm/intro-hook.patch", import.meta.url), "utf8");

// Every hunk header must match its body, or `git apply` in build-game.sh rejects the whole patch on the VM.
test("intro-hook.patch hunk line counts match their headers", () => {
  const lines = patch.replace(/\n$/, "").split("\n");
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(lines[i]);
    if (!m) continue;
    hunks++;
    let oldN = 0, newN = 0;
    for (i++; i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- "); i++) {
      const c = lines[i][0];
      if (c === " ") { oldN++; newN++; } else if (c === "-") oldN++; else if (c === "+") newN++;
    }
    i--;
    assert.deepEqual([oldN, newN], [Number(m[1]), Number(m[2])], `hunk ${hunks} header disagrees with its body`);
  }
  assert.ok(hunks >= 4);
});

// A game parked on the last match's results screen after a session must restart for the next guest like the title or a menu.
test("intro-hook.patch treats the VS results screen as an idle scene a guest can leave", () => {
  const fn = patch.split("\n").filter((l) => l.startsWith("+"));
  const classify = fn.findIndex((l) => l.startsWith("+s32 portSCManagerSceneClass"));
  assert.ok(classify >= 0);
  assert.ok(fn.slice(classify, classify + 14).some((l) => /nSCKindVSResults\) return 4;/.test(l)), "results scene must map to a class 4 (leavable) scene");
  assert.ok(!fn.some((l) => /nSCKindVSBattle\) return [1-4]/.test(l)), "a running match must never be leavable");
});
