// VM-side controller. Drives the host page in the VM's Chrome over the DevTools port:
//  - creates the room and (re)starts capture whenever the game window exists but no capture is live
//    (this is what makes a game restart recover without a human clicking "Start capture"),
//  - publishes the guest links to GCE guest attributes (smash/status) and a local file,
//  - powers the VM off when no guest has been connected for too long (idle shutdown).
// Settings come from /etc/smash-online.env (re-read every tick, so they can change while running).
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const ENV_FILE = process.env.SMASH_ENV_FILE || "/etc/smash-online.env";
const STATE_DIR = process.env.SMASH_STATE_DIR || join(homedir(), ".smash-online");
const CDP = process.env.SMASH_CDP || "http://127.0.0.1:9222";
const GAME_WINDOW = process.env.SMASH_GAME_WINDOW_NAME || "BattleShip";
const TICK_MS = 2000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function settings() {
  const out = { bootGraceMin: 30, idleMin: 15, poweroff: true, vmSecret: "", origin: "" };
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_0-9]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === "SMASH_BOOT_GRACE_MIN") out.bootGraceMin = Number(m[2]);
      if (m[1] === "SMASH_IDLE_MIN") out.idleMin = Number(m[2]);
      if (m[1] === "SMASH_IDLE_POWEROFF") out.poweroff = m[2] !== "0";
      if (m[1] === "SMASH_VM_SECRET") out.vmSecret = m[2].trim();
      if (m[1] === "SMASH_SIGNAL_ORIGIN") out.origin = m[2].trim();
    }
  } catch { /* defaults */ }
  return out;
}
const uptimeSec = () => Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const bootEpoch = () => Math.round(Date.now() / 1000 - uptimeSec());
// Capture is the whole 640x480 virtual screen, so the game window must stay on top of Chrome; raise it on every check.
const xdo = (...args) => new Promise(resolve => execFile("xdotool", args, { env: { ...process.env, DISPLAY: ":99" } }, (err, out) => resolve(err ? "" : out.trim())));
const gameWindowUp = async () => {
  const id = (await xdo("search", "--name", GAME_WINDOW)).split("\n")[0];
  if (id) await xdo("windowraise", id);
  return Boolean(id);
};

// --- DevTools helper -------------------------------------------------------------------------------------
async function pageSocket() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find(t => t.type === "page" && /\/host/.test(t.url));
  if (!page) throw new Error("host page not open yet");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}
let socket = null, nextId = 1;
const pending = new Map();
async function evaluate(expression) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    socket = await pageSocket();
    socket.on("message", data => { const m = JSON.parse(data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    socket.on("close", () => { socket = null; });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("cdp timeout")); }, 15000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    // userGesture: getDisplayMedia needs transient activation, which this grants like a real click.
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
  }).then(r => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; });
}
const PAGE_STATE = `(() => {
  const s = window.__smashHostStats?.();
  return {
    room: s?.room ?? null,
    captured: Boolean(s?.video?.captured),
    slots: s ? Object.fromEntries(Object.entries(s.slots).map(([p, v]) => [p, v.status])) : {},
    links: [...document.querySelectorAll('#guest-links article')].map(a => ({ port: Number(a.querySelector('h3').textContent.slice(1)), url: a.querySelector('input').value })),
    startEnabled: !document.querySelector('#start').disabled,
    resumeVisible: !document.querySelector('#resume').hidden,
  };
})()`;

// --- publishing ------------------------------------------------------------------------------------------
async function publish(value) {
  const body = JSON.stringify(value);
  try {
    writeFileSync(join(STATE_DIR, "status.json"), body, { mode: 0o600 });
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/smash/status", { method: "PUT", headers: { "Metadata-Flavor": "Google" }, body });
    if (!r.ok) log("guest attribute publish failed", r.status);
  } catch (e) { log("publish error", e.message); }
}

// Tell the Worker which room is live, so the permanent P1 / friend links resolve to it. Re-sent every 2 minutes.
let lastRegistered = "", registeredAt = 0;
async function register(cfg, status) {
  if (!cfg.vmSecret || !cfg.origin || !status.ready) return;
  const slots = status.links.map(l => ({ port: l.port, slotToken: new URL(l.url).searchParams.get("slot") })).filter(s => s.slotToken);
  const body = JSON.stringify({ room: status.room, boot: status.boot, slots });
  if (body === lastRegistered && Date.now() - registeredAt < 120000) return;
  try {
    const r = await fetch(`${cfg.origin}/api/vm/register`, { method: "POST", headers: { authorization: `Bearer ${cfg.vmSecret}`, "content-type": "application/json" }, body });
    if (r.ok) { lastRegistered = body; registeredAt = Date.now(); log("registered room with the Worker"); } else log("worker registration failed", r.status);
  } catch (e) { log("worker registration error", e.message); }
}

// --- main loop -------------------------------------------------------------------------------------------
mkdirSync(STATE_DIR, { recursive: true });
const myBoot = bootId();
const startedAt = Date.now(); // the grace period counts from when the services start, so a long first-run build does not eat it
let lastPublished = "", sessionHappened = false, lastGuestAt = 0, clickAt = 0, lastRoom = null;

async function tick() {
  const cfg = settings();
  let st;
  try { st = await evaluate(PAGE_STATE); } catch (e) { log("page not ready:", e.message); return; }
  const now = Date.now();
  const gameUp = await gameWindowUp(); // also raises the game above Chrome: capture is the whole screen
  if (st.room !== lastRoom) { log("room", st.room); lastRoom = st.room; }
  if (!st.room && st.startEnabled && now - clickAt > 5000) { clickAt = now; log("creating room"); await evaluate("document.querySelector('#start').click()").catch(() => {}); }
  else if (st.room && !st.captured && now - clickAt > 8000 && gameUp) { clickAt = now; log("starting capture"); await evaluate("document.querySelector('#resume').click()").catch(() => {}); }

  const connected = Object.values(st.slots).filter(v => v === "connected" || v === "connecting").length;
  if (connected > 0) { sessionHappened = true; lastGuestAt = now; }
  // Chrome's "is sharing your screen" bubble is a real window on the captured screen; park it off-screen.
  for (const id of (await xdo("search", "--name", "is sharing your screen")).split("\n").filter(Boolean)) await xdo("windowmove", id, "5000", "5000");
  const ready = Boolean(st.room) && st.captured && st.links.length > 0;
  const status = { boot: bootEpoch(), bootId: myBoot, ready, room: st.room, captured: st.captured, guests: connected, links: ready || st.links.length ? st.links : [] };
  const text = JSON.stringify(status);
  if (text !== lastPublished) { lastPublished = text; await publish(status); }
  await register(cfg, status);

  // Idle shutdown: before any session, a boot grace period; after one, idleMin without any guest.
  const idleFor = (now - lastGuestAt) / 60000;
  if (connected === 0) {
    const expired = sessionHappened ? idleFor >= cfg.idleMin : (now - startedAt) / 60000 >= cfg.bootGraceMin;
    if (expired) {
      log(`idle shutdown (${sessionHappened ? `no guest for ${idleFor.toFixed(1)} min` : "no guest since boot"}); poweroff=${cfg.poweroff}`);
      if (cfg.poweroff) execFile("sudo", ["-n", "systemctl", "poweroff"], () => {});
      await new Promise(r => setTimeout(r, 60000));
    }
  }
}
log(`controller up; boot ${myBoot}; settings`, settings());
for (;;) { await tick().catch(e => log("tick error", e.message)); await new Promise(r => setTimeout(r, TICK_MS)); }
