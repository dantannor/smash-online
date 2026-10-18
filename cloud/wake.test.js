import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${PORT}`;
const INVITE = "invite_secret_for_tests", P1 = "p1_secret_for_tests", FRIEND = "friend_secret_for_tests", VM = "vm_secret_for_tests";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const saJson = JSON.stringify({ client_email: "wake@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

// Stub of the Compute API and the OAuth token endpoint.
const gcp = { suspendedAt: undefined, stops: 0, status: "TERMINATED", lastStart: new Date(0).toISOString(), starts: 0, resumes: 0, suspends: 0, tokens: 0, badJwt: 0 };
let stub, dev;
test.before(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/token") {
      let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
        const [h, c, sig] = new URLSearchParams(body).get("assertion").split(".");
        const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
        const claims = JSON.parse(Buffer.from(c, "base64url"));
        if (!ok || claims.iss !== "wake@test.iam.gserviceaccount.com" || !/compute/.test(claims.scope)) { gcp.badJwt++; res.writeHead(400).end("{}"); return; }
        gcp.tokens++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      });
      return;
    }
    if (req.headers.authorization !== "Bearer tok") { res.writeHead(401).end("{}"); return; }
    const base = "/compute/v1/projects/proj/zones/zone/instances/vm";
    if (req.method === "GET" && url.pathname === base) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: gcp.status, lastStartTimestamp: gcp.lastStart, lastSuspendedTimestamp: gcp.suspendedAt })); return; }
    if (req.method === "POST" && url.pathname === `${base}/start`) { gcp.starts++; gcp.status = "RUNNING"; gcp.lastStart = new Date().toISOString(); res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    if (req.method === "POST" && url.pathname === `${base}/resume`) { gcp.resumes++; gcp.status = "RUNNING"; gcp.lastStart = new Date().toISOString(); res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    if (req.method === "POST" && url.pathname === `${base}/suspend`) { gcp.suspends++; gcp.status = "SUSPENDED"; res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    if (req.method === "POST" && url.pathname === `${base}/stop`) { gcp.stops++; gcp.status = "TERMINATED"; res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubOrigin = `http://127.0.0.1:${stub.address().port}`;
  execFileSync("node", [join(here, "build-assets.mjs")]);
  const vars = { INVITE_SECRET: INVITE, P1_SECRET: P1, FRIEND_SECRET: FRIEND, VM_SECRET: VM, GCP_SA_JSON: saJson, GCP_API_BASE: stubOrigin, GCP_TOKEN_URL: `${stubOrigin}/token`, GCP_PROJECT: "proj", GCP_ZONE: "zone", GCP_INSTANCE: "vm" };
  const args = ["wrangler", "dev", "--local",  "--port", String(PORT), "--persist-to", join(here, ".wrangler", `wake-${PORT}`), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  dev = spawn("npx", args, { cwd: here, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error("wrangler dev did not start");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});
test.after(() => { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* gone */ } stub?.close(); });

const get = (path) => fetch(`${origin}${path}`, { redirect: "manual" });
const status = async (path) => (await get(path)).json();
const register = (body, token = VM) => fetch(`${origin}/api/vm/register`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const reg = (boot = 0) => ({ room: "room1", boot, slots: [1, 2, 3, 4].map((port) => ({ port, slotToken: `tok${port}` })) });

test("wrong secrets get 404 and the VM stays down", async () => {
  assert.equal((await get("/go/nope")).status, 404);
  assert.equal((await get("/go/nope/status?wake=1")).status, 404);
  assert.equal((await get("/p/nope/2")).status, 404);
  assert.equal((await get("/go/wrong%5C_secret")).status, 404);
  assert.equal((await get("/p/wrong%5C_secret/2")).status, 404);
  assert.equal(gcp.starts, 0);
});

test("markdown-escaped underscores work in permanent links without waking the VM", async () => {
  const escapedP1 = P1.replace("_", "%5C_");
  const escapedFriend = FRIEND.replace("_", "%5C_");
  const goPage = await get(`/go/${escapedP1}`);
  assert.equal(goPage.status, 200);
  assert.match(await goPage.text(), /Starting server/);
  const friendPage = await get(`/p/${escapedFriend}/2`);
  assert.equal(friendPage.status, 200);
  assert.match(await friendPage.text(), /Starting server/);
  assert.equal(gcp.starts, 0, "opening either link does not start the VM");
});

test("pages show the starting / waiting state and the permanent friend links", async () => {
  const page = await (await get(`/go/${P1}`)).text();
  assert.match(page, /Starting server/);
  assert.ok(page.includes(`${origin}/p/${FRIEND}/2`) && page.includes(`${origin}/p/${FRIEND}/4`));
  const friendPage = await (await get(`/p/${FRIEND}/3`)).text();
  assert.match(friendPage, /Starting server/);
  assert.ok(page.includes(`${origin}/join/${INVITE}`), "the loading page shows the invite link");
  assert.equal(gcp.starts, 0, "viewing pages and friend links never starts the VM");
});

test("plain status reads never wake the VM; a poll with wake=1 from the P1 link does, once", async () => {
  assert.equal((await status(`/p/${FRIEND}/2/status`)).state, "down");
  assert.equal((await status(`/go/${P1}/status`)).state, "down");
  assert.equal((await status(`/join/${INVITE}/status?c=x`)).state, "down");
  assert.equal(gcp.starts, 0);
  assert.equal((await status(`/go/${P1}/status?wake=1`)).state, "starting");
  assert.equal(gcp.starts, 1);
  assert.equal((await status(`/go/${P1}/status?wake=1`)).state, "starting", "running but not registered yet");
  assert.equal(gcp.starts, 1, "no second start while running");
  assert.equal(gcp.badJwt, 0);
  assert.ok(gcp.tokens >= 1);
});

test("registration is authenticated; a fresh registration makes P1 and friends ready", async () => {
  assert.equal((await register(reg(Math.floor(Date.now() / 1000)), "wrong")).status, 403);
  assert.equal((await register({ room: "r" })).status, 400);
  assert.equal((await register(reg(Math.floor(Date.now() / 1000)))).status, 200);
  const p1 = await status(`/go/${P1}/status`);
  assert.equal(p1.state, "ready");
  assert.equal(p1.url, `${origin}/play?room=room1&slot=tok1`);
  assert.equal((await status(`/p/${FRIEND}/3/status`)).url, `${origin}/play?room=room1&slot=tok3`);
  // even with the VM up, a link serves the waiting page (it records smash-entry, the guest's way back when its room dies), never a bare 302
  const page = await get(`/p/${FRIEND}/4`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /smash-entry/);
  assert.notEqual((await get(`/p/${FRIEND}/1`)).status, 302, "port 1 is not a friend slot");
});

test("a registration that predates the current run is stale; stopped is down and gets started", async () => {
  await register(reg());
  gcp.status = "RUNNING"; gcp.lastStart = new Date(Date.now() + 60_000).toISOString(); // the VM (re)started after that registration
  assert.equal((await status(`/go/${P1}/status`)).state, "starting");
  gcp.status = "TERMINATED";
  assert.equal((await status(`/p/${FRIEND}/2/status`)).state, "down");
  const startsBefore = gcp.starts;
  assert.equal((await status(`/go/${P1}/status?wake=1`)).state, "starting");
  assert.equal(gcp.starts, startsBefore + 1);
  gcp.status = "STOPPING";
  assert.equal((await status(`/go/${P1}/status?wake=1`)).state, "stopping");
  assert.equal(gcp.starts, startsBefore + 1, "never starts while still stopping");
});

test("a suspended VM is resumed (not started) by the P1 link only, and idle suspend is authenticated", async () => {
  gcp.status = "SUSPENDED";
  assert.equal((await status(`/p/${FRIEND}/2/status`)).state, "down");
  assert.equal((await status(`/go/${P1}/status`)).state, "down");
  assert.equal(gcp.resumes, 0);
  const starts = gcp.starts;
  assert.equal((await status(`/go/${P1}/status?wake=1`)).state, "starting");
  assert.equal(gcp.resumes, 1); assert.equal(gcp.starts, starts, "resume, not start");
  await register(reg());
  assert.equal((await status(`/go/${P1}/status`)).state, "ready");
  const suspend = token => fetch(`${origin}/api/vm/suspend`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal((await suspend("wrong")).status, 403);
  assert.equal(gcp.suspends, 0);
  assert.equal((await suspend(VM)).status, 200);
  assert.equal(gcp.suspends, 1);
  assert.equal((await status(`/go/${P1}/status`)).state, "down", "registration cleared and VM suspended");
  assert.equal((await suspend(VM)).status, 409, "only a running VM can be suspended");
});

test("wake history is recorded", async () => {
  const wakes = async () => (await (await fetch(`${origin}/api/vm/wakes`, { headers: { authorization: `Bearer ${VM}` } })).json()).wakes;
  assert.equal((await fetch(`${origin}/api/vm/wakes`)).status, 403);
  const log = await wakes();
  assert.ok(log.some((w) => w.action === "resume" && Number.isFinite(w.apiMs)) && log.some((w) => w.action === "start"));
});

test("every link wakes the VM; the invite link hands out P1..P4 in order, remembers a returning browser, and says full", async () => {
  // friend link wakes a stopped VM
  gcp.status = "TERMINATED"; const starts = gcp.starts;
  assert.equal((await status(`/p/${FRIEND}/3/status?wake=1`)).state, "starting");
  assert.equal(gcp.starts, starts + 1);
  // invite link wakes a suspended one
  gcp.status = "SUSPENDED"; const resumes = gcp.resumes;
  assert.equal((await status(`/join/${INVITE}/status?wake=1&c=aaa`)).state, "starting");
  assert.equal(gcp.resumes, resumes + 1);
  await register(reg());
  const open = async (c) => status(`/join/${INVITE}/status?wake=1&c=${c}`);
  const first = await open("aaa"), second = await open("bbb"), third = await open("ccc");
  assert.deepEqual([first.port, second.port, third.port], [1, 2, 3]);
  assert.match(first.url, /slot=tok1$/); assert.match(second.url, /slot=tok2$/);
  assert.equal((await open("bbb")).port, 2, "a reload keeps the slot");
  assert.equal((await open("ddd")).port, 4);
  const fifth = await open("eee");
  assert.equal(fifth.state, "full"); assert.match(fifth.message, /full/);
  assert.equal((await open("aaa")).port, 1, "returning player still has their slot while the room is full");
  // a permanent link takes its own port regardless
  assert.equal((await status(`/go/${P1}/status`)).state, "ready");
});
