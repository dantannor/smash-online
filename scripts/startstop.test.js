import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const start = join(root, "scripts/start.sh");
const stop = join(root, "scripts/stop.sh");

async function freePort() {
  return new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sh = (script, env, ...args) => spawnSync("perl", ["-e", "alarm 40; exec @ARGV", script, ...args], { env, encoding: "utf8", timeout: 45000 });
const groupMembers = (pgid) => spawnSync("ps", ["-axo", "pgid=,stat=,pid="], { encoding: "utf8" }).stdout
  .split("\n").map((l) => l.trim().split(/\s+/)).filter(([g, st]) => Number(g) === pgid && !st.startsWith("Z")).map(([, , p]) => Number(p));
const readPids = (base) => Object.fromEntries(readFileSync(join(base, "current/pids"), "utf8").trim().split("\n").map((l) => { const [r, p] = l.split(" "); return [r, Number(p)]; }));

test("start.sh and stop.sh manage an isolated stack", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "smash-startstop-"));
  const base = join(dir, "run");
  const input = join(dir, "input.osi1");
  const env = {
    ...process.env,
    SMASH_RUN_BASE: base,
    SMASH_INPUT_FILE: input,
    SMASH_SIDECAR_PORT: String(await freePort()),
    SMASH_SERVER_PORT: String(await freePort()),
    SMASH_GAME_CMD: 'head -c 80 /dev/zero > "$OPENSMASH_LAUNCHER_INPUT"; exec sleep 4711',
    SMASH_GAME_SETTLE: "0",
    SMASH_NO_BROWSER: "1",
    SMASH_GAME_TIMEOUT: "15",
  };
  delete env.OPENSMASH_LAUNCHER_INPUT;
  t.after(() => { sh(stop, env, "--quiet", "--purge"); rmSync(dir, { recursive: true, force: true }); });

  await t.test("stop with nothing running is safe", () => {
    const r = sh(stop, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing to stop/);
  });

  let pids;
  await t.test("start launches game, sidecar and server (local mode)", () => {
    const r = sh(start, env, "--local");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Start capture|Open the host page/);
    assert.match(r.stdout, /guest links/);
    pids = readPids(base);
    assert.deepEqual(Object.keys(pids).sort(), ["game", "server", "sidecar"]);
    for (const pid of Object.values(pids)) assert.ok(alive(pid), `pid ${pid} alive`);
    assert.match(readFileSync(join(base, "current/host-url"), "utf8").trim(), new RegExp(`127\\.0\\.0\\.1:${env.SMASH_SERVER_PORT}/host$`));
    assert.match(readFileSync(join(base, "current/sidecar.log"), "utf8"), /sidecar listening/);
    assert.ok(existsSync(input));
  });

  await t.test("sidecar runs muted and each role is its own session leader", () => {
    const cmd = spawnSync("ps", ["-p", String(pids.sidecar), "-o", "command="], { encoding: "utf8" }).stdout;
    assert.match(cmd, /--mute/);
    assert.match(cmd, new RegExp(`--port ${env.SMASH_SIDECAR_PORT}`));
    for (const pid of Object.values(pids)) assert.ok(groupMembers(pid).includes(pid));
  });

  await t.test("second start is idempotent", () => {
    const r = sh(start, env, "--local");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Already running/);
    assert.deepEqual(readPids(base), pids);
    assert.equal(readdirSync(base).filter((n) => n !== "current").length, 1);
  });

  await t.test("stop kills everything and cleans state", () => {
    const r = sh(stop, env);
    assert.equal(r.status, 0, r.stderr);
    for (const role of ["server", "sidecar", "game"]) assert.match(r.stdout, new RegExp(`${role} \\(pid ${pids[role]}\\): stopped`));
    for (const pid of Object.values(pids)) {
      assert.ok(!alive(pid), `pid ${pid} gone`);
      assert.deepEqual(groupMembers(pid), [], `no orphans in group ${pid}`);
    }
    assert.ok(!existsSync(join(base, "current")));
    const again = sh(stop, env);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Nothing to stop/);
  });

  await t.test("start refuses when a port is taken and starts nothing", async () => {
    const blocker = createServer().listen(Number(env.SMASH_SERVER_PORT), "127.0.0.1");
    await new Promise((ok) => blocker.once("listening", ok));
    try {
      const r = sh(start, env, "--local");
      assert.equal(r.status, 2);
      assert.match(r.stderr, /already in use/);
      assert.ok(!existsSync(join(base, "current")));
    } finally { blocker.close(); }
  });

  await t.test("worker mode needs a reachable Worker and uses its signal URL", async () => {
    const dead = { ...env, SMASH_SIGNAL_ORIGIN: `http://127.0.0.1:${await freePort()}` };
    const r = sh(start, dead);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Worker not reachable/);
    assert.ok(!existsSync(join(base, "current")));
    // A second local server instance stands in for the Worker's /healthz.
    const fakePort = await freePort();
    const fake = spawn("node", [join(root, "server/index.js")], { env: { ...process.env, PORT: String(fakePort), HOST: "127.0.0.1" }, stdio: "ignore" });
    try {
      await new Promise((ok, no) => { const end = Date.now() + 10000; const tick = () => fetch(`http://127.0.0.1:${fakePort}/healthz`).then(ok, () => (Date.now() > end ? no(new Error("fake worker")) : setTimeout(tick, 100))); tick(); });
      const live = { ...env, SMASH_SIGNAL_ORIGIN: `http://127.0.0.1:${fakePort}` };
      const ok = sh(start, live);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(readFileSync(join(base, "current/host-url"), "utf8").trim(), `http://127.0.0.1:${env.SMASH_SERVER_PORT}/host?signal=http://127.0.0.1:${fakePort}`);
      assert.equal(sh(stop, env).status, 0);
    } finally { fake.kill(); }
  });

  await t.test("a failed start rolls back", () => {
    const bad = { ...env, SMASH_GAME_CMD: "sleep 4712" , SMASH_GAME_TIMEOUT: "2" };
    rmSync(input, { force: true });
    const r = sh(start, bad, "--local");
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(base, "current")));
    const left = spawnSync("pgrep", ["-f", "sleep 4712"], { encoding: "utf8" }).stdout.trim();
    assert.equal(left, "", "fake game from the failed start is gone");
  });
});
