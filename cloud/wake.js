// Permanent links and wake-on-open. Opening the P1 URL starts the stopped GCE VM through the Compute API (service-account JWT
// signed with WebCrypto); friend URLs only wait. The VM registers its room here (Bearer VM_SECRET) once it is ready.
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const pathSecret = (segment) => {
  try {
    const secret = decodeURIComponent(segment).replaceAll("\\", "");
    return /^[A-Za-z0-9_-]+$/.test(secret) ? secret : null;
  } catch { return null; }
};
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });

async function sameSecret(supplied, expected) {
  if (!expected || typeof supplied !== "string") return false;
  const [a, b] = await Promise.all([supplied, expected].map(async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v)))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---- GCP -------------------------------------------------------------------------------------------------
let tokenCache = { token: "", expires: 0 };
async function accessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expires - 60_000) return tokenCache.token;
  const key = JSON.parse(env.GCP_SA_JSON);
  const tokenUri = env.GCP_TOKEN_URL || key.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/compute", aud: tokenUri, iat: now, exp: now + 3600 })));
  const der = Uint8Array.from(atob(key.private_key.replace(/-----[A-Z ]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(`${head}.${claims}`));
  const response = await fetch(tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(signature)}` }) });
  if (!response.ok) throw new Error(`token exchange failed (${response.status})`);
  const body = await response.json();
  tokenCache = { token: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
const instanceUrl = (env) => `${env.GCP_API_BASE || "https://compute.googleapis.com"}/compute/v1/projects/${env.GCP_PROJECT}/zones/${env.GCP_ZONE}/instances/${env.GCP_INSTANCE}`;
async function gcp(env, path, init = {}) {
  const response = await fetch(instanceUrl(env) + path, { ...init, headers: { authorization: `Bearer ${await accessToken(env)}` } });
  if (!response.ok) throw new Error(`compute api ${path || "get"} failed (${response.status})`);
  return response.json();
}
export const getInstance = (env) => gcp(env, "");
export const startInstance = (env) => gcp(env, "/start", { method: "POST" });
export const resumeInstance = (env) => gcp(env, "/resume", { method: "POST" });
export const suspendInstance = (env) => gcp(env, "/suspend", { method: "POST" });

// Cron: a VM that has been suspended for a long time is slow to resume (observed 78 s click to registration after 6 h, against
// 22 s after 33 min), so past SLEEP_STOP_MIN minutes turn the suspend into a power-off: a cold start is a steady ~30 s.
export async function sweepSleepers(env) {
  const instance = await getInstance(env);
  if (instance.status !== "SUSPENDED") return "not suspended";
  const since = Date.parse(instance.lastSuspendedTimestamp || "") || Date.now();
  if (Date.now() - since < Number(env.SLEEP_STOP_MIN || 30) * 60_000) return "recently suspended";
  await gcp(env, "/stop", { method: "POST" });
  await registry(env).logWake({ action: "sweep-stop", suspendedAt: instance.lastSuspendedTimestamp });
  return "stopped";
}

// ---- state -----------------------------------------------------------------------------------------------
const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName("vm"));
const STOPPED = new Set(["TERMINATED", "STOPPED"]);
// The VM re-registers its room every minute; a registration older than this means it is not running our session (it was
// suspended, powered off, or crashed), whatever the instance status says.
const FRESH_MS = 150_000;

// -> { state: "down" | "stopping" | "starting" | "ready", slots?: {port: slotToken}, room? }
// "down" covers stopped and suspended VMs; with wake=true a stopped VM is started and a suspended one resumed.
export async function vmState(env, { wake = false } = {}) {
  const instance = await getInstance(env);
  const asleep = STOPPED.has(instance.status) || instance.status === "SUSPENDED";
  if (asleep) {
    if (!wake) return { state: "down" };
    await registry(env).clear();           // never hand out a previous run's room
    const action = instance.status === "SUSPENDED" ? "resume" : "start";
    const t0 = Date.now();
    try { await (action === "resume" ? resumeInstance(env) : startInstance(env)); }
    catch (error) { await registry(env).logWake({ action, from: instance.status, error: error.message }); throw error; }
    await registry(env).logWake({ action, from: instance.status, apiMs: Date.now() - t0, suspendedAt: instance.lastSuspendedTimestamp || null });
    return { state: "starting" };
  }
  if (instance.status === "STOPPING" || instance.status === "SUSPENDING") return { state: "stopping" };
  if (instance.status !== "RUNNING") return { state: "starting" };
  const current = await registry(env).current();
  const started = Date.parse(instance.lastStartTimestamp || "") || 0;
  if (!current || current.at < Date.now() - FRESH_MS || current.at < started) return { state: "starting" };
  return { state: "ready", room: current.room, slots: current.slots };
}
const playUrl = (origin, room, token) => `${origin}/play?room=${encodeURIComponent(room)}&slot=${encodeURIComponent(token)}`;

// ---- pages -----------------------------------------------------------------------------------------------
const STYLE = `<style>:root{color-scheme:dark;font:17px system-ui,sans-serif;background:#10151d;color:#edf2f7}body{max-width:34rem;margin:12vh auto;padding:0 1.2rem}h1{font-size:1.5rem}.muted{color:#a8b3c2}button{padding:.5rem 1rem;border:0;border-radius:.4rem;background:#5b5be8;color:#fff;font:inherit;font-weight:700;cursor:pointer}input{width:100%;margin:.2rem 0 .8rem;padding:.5rem;border-radius:.4rem;border:1px solid #334;background:#1b2430;color:inherit;font:inherit}.bar{height:.4rem;background:#1b2430;border-radius:.2rem;overflow:hidden}.bar i{display:block;height:100%;width:40%;background:#42e8a4;animation:s 1.4s ease-in-out infinite alternate}@keyframes s{from{margin-left:0}to{margin-left:60%}}</style>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pollScript = (statusUrl) => `<script>
const started = Date.now(), el = document.getElementById("msg");
// a returning browser keeps its slot on the invite link
let client = ""; try { client = localStorage.getItem("smash-client") || ""; if (!client) { client = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem("smash-client", client); } } catch { client = "tmp" + Math.random().toString(36).slice(2); }
// remembered so a guest page that finds its room dead can come back here for the current one
try { sessionStorage.setItem("smash-entry", location.pathname); } catch {}
async function tick() {
  try {
    const s = await (await fetch(${JSON.stringify(statusUrl)} + "&c=" + client, { cache: "no-store" })).json();
    if (s.url) { location.replace(s.url); return; }
    if (s.state === "full") { el.textContent = s.message; document.querySelector(".bar").hidden = true; return; }
    const secs = Math.round((Date.now() - started) / 1000);
    el.textContent = s.message + " (" + secs + " s)";
  } catch { el.textContent = "Connection hiccup, retrying…"; }
  setTimeout(tick, 500);
}
tick();
</script>`;
function waitPage({ title, message, statusUrl, extra = "" }) {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}<h1>${esc(title)}</h1><div class="bar"><i></i></div><p id="msg" class="muted">${esc(message)}</p>${extra}${pollScript(statusUrl)}`);
}

// ---- routes ----------------------------------------------------------------------------------------------
export async function handleWake(request, env, url) {
  const origin = url.origin;
  if (url.pathname === "/api/vm/wakes") {
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!(await sameSecret(bearer, env.VM_SECRET))) return json(403, { error: "forbidden" });
    return json(200, { wakes: await registry(env).wakes() });
  }
  if (url.pathname === "/api/vm/register" || url.pathname === "/api/vm/clear" || url.pathname === "/api/vm/suspend") {
    if (request.method !== "POST") return json(405, { error: "method" });
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!(await sameSecret(bearer, env.VM_SECRET))) return json(403, { error: "forbidden" });
    if (url.pathname === "/api/vm/clear") { await registry(env).clear(); return json(200, { ok: true }); }
    if (url.pathname === "/api/vm/suspend") { // the idle VM asks to be suspended: it has no cloud credentials of its own
      const instance = await getInstance(env).catch(() => null);
      if (instance?.status !== "RUNNING") return json(409, { error: "not running" });
      await registry(env).clear();
      await suspendInstance(env);
      return json(200, { ok: true });
    }
    const body = await request.json().catch(() => null);
    const slots = Object.fromEntries((Array.isArray(body?.slots) ? body.slots : []).filter((s) => [1, 2, 3, 4].includes(s?.port) && typeof s?.slotToken === "string").map((s) => [s.port, s.slotToken]));
    if (typeof body?.room !== "string" || !Number.isFinite(body?.boot) || !Object.keys(slots).length) return json(400, { error: "bad registration" });
    await registry(env).register({ room: body.room, boot: body.boot, slots });
    return json(200, { ok: true });
  }

  const msgFor = (state) => state === "error" ? "Could not reach the cloud API, retrying…" : state === "stopping" ? "The server is shutting down, it will start again in a moment" : "Starting server, about 30 seconds";
  // Every link wakes the VM (the status poll with wake=1); plain status reads never do. A permanent P1/friend link names its port,
  // the invite link takes the lowest free one. `claim` records who holds which port so the next opener gets the next port.
  async function resolve({ wake, port, client }) {
    const s = await vmState(env, { wake }).catch((e) => ({ state: "error", error: e.message }));
    if (s.state !== "ready") return { state: s.state, message: msgFor(s.state) };
    let chosen = port;
    if (!port) {
      let connected = [];
      try { connected = await env.ROOM.get(env.ROOM.idFromName(s.room)).connected(); } catch { /* treat as none connected */ }
      chosen = await registry(env).claim({ room: s.room, client: client || "anonymous", connected });
      if (chosen === null) return { state: "full", message: "This game is full (4 of 4 players). Ask someone to leave, or try again in a minute." };
    } else await registry(env).claim({ room: s.room, client: `fixed-${port}`, port, connected: [] });
    if (!s.slots[chosen]) return { state: "starting", message: msgFor("starting") };
    return { state: "ready", port: chosen, url: playUrl(origin, s.room, s.slots[chosen]) };
  }
  const clientOf = (u) => (u.searchParams.get("c") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const inviteBox = () => env.INVITE_SECRET ? `<h2>Invite link</h2><p class="muted">Share this with the other players. Whoever opens it next becomes the next player.</p><input id="invite" readonly value="${esc(`${origin}/join/${env.INVITE_SECRET}`)}" onclick="this.select()"><button id="copy" type="button" onclick="navigator.clipboard.writeText(document.getElementById('invite').value).then(()=>{this.textContent='Copied'}).catch(()=>{document.getElementById('invite').select();document.execCommand('copy');this.textContent='Copied'})">Copy link</button>` : "";

  const p1 = url.pathname.match(/^\/go\/([^/]+)(\/status)?$/);
  if (p1) {
    const secret = pathSecret(p1[1]);
    if (!secret || !(await sameSecret(secret, env.P1_SECRET))) return html("Not found", 404);
    if (p1[2]) return json(200, await resolve({ wake: url.searchParams.get("wake") === "1", port: 1 }));
    const now = await resolve({ wake: false, port: 1 });
    if (now.url) return new Response(null, { status: 302, headers: { location: now.url, "cache-control": "no-store" } });
    return waitPage({ title: "Starting the Smash server", message: msgFor("starting"), statusUrl: `/go/${secret}/status?wake=1`, extra: inviteBox() + `<h2>Friend links</h2>` + [2, 3, 4].map((port) => `<label class="muted">P${port}</label><input readonly value="${esc(`${origin}/p/${env.FRIEND_SECRET}/${port}`)}" onclick="this.select()">`).join("") });
  }

  const friend = url.pathname.match(/^\/p\/([^/]+)\/([2-4])(\/status)?$/);
  if (friend) {
    const secret = pathSecret(friend[1]);
    if (!secret || !(await sameSecret(secret, env.FRIEND_SECRET))) return html("Not found", 404);
    const port = Number(friend[2]);
    if (friend[3]) return json(200, await resolve({ wake: url.searchParams.get("wake") === "1", port }));
    const now = await resolve({ wake: false, port });                     // already up: skip the waiting page
    if (now.url) return new Response(null, { status: 302, headers: { location: now.url, "cache-control": "no-store" } });
    return waitPage({ title: `Smash Online, player ${port}`, message: msgFor("starting"), statusUrl: `/p/${secret}/${port}/status?wake=1`, extra: inviteBox() });
  }

  const invite = url.pathname.match(/^\/join\/([^/]+)(\/status)?$/);
  if (invite) {
    const secret = pathSecret(invite[1]);
    if (!env.INVITE_SECRET || !secret || !(await sameSecret(secret, env.INVITE_SECRET))) return html("Not found", 404);
    if (invite[2]) return json(200, await resolve({ wake: url.searchParams.get("wake") === "1", client: clientOf(url) }));
    return waitPage({ title: "Joining the Smash game", message: msgFor("starting"), statusUrl: `/join/${secret}/status?wake=1`, extra: inviteBox() });
  }
  return null;
}
