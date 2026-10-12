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
const P1 = "p1-secret-for-tests", FRIEND = "friend-secret-for-tests", VM = "vm-secret-for-tests";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const saJson = JSON.stringify({ client_email: "wake@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

// Stub of the Compute API and the OAuth token endpoint.
const gcp = { status: "TERMINATED", lastStart: new Date(0).toISOString(), starts: 0, tokens: 0, badJwt: 0 };
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
    if (req.method === "GET" && url.pathname === base) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: gcp.status, lastStartTimestamp: gcp.lastStart })); return; }
    if (req.method === "POST" && url.pathname === `${base}/start`) { gcp.starts++; gcp.status = "RUNNING"; gcp.lastStart = new Date().toISOString(); res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubOrigin = `http://127.0.0.1:${stub.address().port}`;
  execFileSync("node", [join(here, "build-assets.mjs")]);
  const vars = { P1_SECRET: P1, FRIEND_SECRET: FRIEND, VM_SECRET: VM, GCP_SA_JSON: saJson, GCP_API_BASE: stubOrigin, GCP_TOKEN_URL: `${stubOrigin}/token`, GCP_PROJECT: "proj", GCP_ZONE: "zone", GCP_INSTANCE: "vm" };
  const args = ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", join(here, ".wrangler", `wake-${PORT}`), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
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
const reg = (boot) => ({ room: "room1", boot, slots: [1, 2, 3, 4].map((port) => ({ port, slotToken: `tok${port}` })) });

test("wrong secrets get 404 and the VM stays down", async () => {
  assert.equal((await get("/go/nope")).status, 404);
  assert.equal((await get("/go/nope/status?wake=1")).status, 404);
  assert.equal((await get("/p/nope/2")).status, 404);
  assert.equal(gcp.starts, 0);
});

test("pages show the starting / waiting state and the permanent friend links", async () => {
  const page = await (await get(`/go/${P1}`)).text();
  assert.match(page, /Starting server/);
  assert.ok(page.includes(`${origin}/p/${FRIEND}/2`) && page.includes(`${origin}/p/${FRIEND}/4`));
  const friendPage = await (await get(`/p/${FRIEND}/3`)).text();
  assert.match(friendPage, /Waiting for the host/);
  assert.equal(gcp.starts, 0, "viewing pages and friend links never starts the VM");
});

test("friend links and plain status polling do not wake the VM; the P1 poll with wake=1 does, once", async () => {
  assert.equal((await status(`/p/${FRIEND}/2/status`)).state, "down");
  assert.equal((await status(`/go/${P1}/status`)).state, "down");
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
  const redirect = await get(`/p/${FRIEND}/4`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `${origin}/play?room=room1&slot=tok4`);
  assert.notEqual((await get(`/p/${FRIEND}/1`)).status, 302, "port 1 is not a friend slot");
});

test("a registration from a previous boot is stale, and a stopped VM is down again", async () => {
  gcp.lastStart = new Date().toISOString();
  await register(reg(Math.floor(Date.now() / 1000) - 3600));
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
