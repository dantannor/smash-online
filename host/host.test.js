import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const hostDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(hostDir, "..");

test("host room links, canvas capture recovery, and guest input forwarding", { timeout: 50_000 }, async t => {
  let roomServer, sidecarServer, browser;
  const clients = new Set();
  const sidecarMessages = [];
  let hostSocket, guestSocket, connectionId = "guest-connection-1";
  let pendingOffer = null;
  let roomCount = 0;
  try {
    roomServer = http.createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        roomCount++;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ room: "room12345678", roomToken: "hosttoken12345678", hostUrl: "", slots: [2, 3, 4].map(slot => ({ port: slot, slotToken: `slottoken${slot}123456`, guestUrl: `http://127.0.0.1:${roomServer.address().port}/play?room=room12345678&slot=slottoken${slot}123456` })) }));
        return;
      }
      if (url.pathname === "/api/ice") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ iceServers: [] })); return; }
      let file;
      if (["/host", "/host/", "/host/index.html"].includes(url.pathname)) file = path.join(hostDir, "index.html");
      else if (url.pathname === "/host/host.js") file = path.join(hostDir, "host.js");
      else if (url.pathname === "/shared/protocol.js") file = path.join(repoDir, "shared", "protocol.js");
      if (file) {
        try { response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" }); response.end(await readFile(file)); }
        catch { response.writeHead(404).end(); }
        return;
      }
      response.writeHead(404).end();
    });
    const signalWss = new WebSocketServer({ noServer: true });
    roomServer.on("upgrade", (request, socket, head) => signalWss.handleUpgrade(request, socket, head, ws => signalWss.emit("connection", ws, request)));
    signalWss.on("connection", (ws, request) => {
      const role = new URL(request.url, `http://${request.headers.host}`).searchParams.get("role");
      clients.add(ws);
      ws.on("close", () => {
        clients.delete(ws);
        if (ws === hostSocket) hostSocket = null;
        if (ws === guestSocket) guestSocket = null;
      });
      if (role === "host") {
        hostSocket = ws;
        if (guestSocket?.readyState === WebSocket.OPEN) hostSocket.send(JSON.stringify({ type: "slot:connected", port: 2, connectionId }));
      } else {
        guestSocket = ws;
        if (hostSocket?.readyState === WebSocket.OPEN) {
          hostSocket.send(JSON.stringify({ type: "slot:connected", port: 2, connectionId }));
          if (pendingOffer) guestSocket.send(JSON.stringify(pendingOffer));
        }
      }
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        const other = ws === hostSocket ? guestSocket : hostSocket;
        if (ws === hostSocket && message.type === "offer") pendingOffer = { ...message, port: 2 };
        if (other?.readyState === WebSocket.OPEN) other.send(JSON.stringify({ ...message, port: 2 }));
      });
    });
    await new Promise((resolve, reject) => { roomServer.listen(0, "127.0.0.1", resolve); roomServer.once("error", reject); });
    sidecarServer = http.createServer();
    const sidecarWss = new WebSocketServer({ server: sidecarServer });
    sidecarWss.on("connection", ws => { ws.send(JSON.stringify({ type: "ready" })); ws.on("message", raw => sidecarMessages.push(JSON.parse(raw.toString()))); });
    await new Promise((resolve, reject) => { sidecarServer.listen(0, "127.0.0.1", resolve); sidecarServer.once("error", reject); });

    browser = await chromium.launch({ headless: true, timeout: 15_000, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript(sidecarPort => { window.__SMASH_E2E_SIDECAR_URL__ = `ws://127.0.0.1:${sidecarPort}`; }, sidecarServer.address().port);
    const hostPage = await context.newPage();
    hostPage.setDefaultTimeout(10_000); hostPage.setDefaultNavigationTimeout(15_000);
    await hostPage.goto(`http://127.0.0.1:${roomServer.address().port}/host?source=canvas`, { timeout: 15_000 });
    await hostPage.locator("#start").click({ timeout: 10_000 });
    await hostPage.getByRole("heading", { name: "P2" }).waitFor({ timeout: 10_000 });
    assert.equal(await hostPage.locator("#guest-links article").count(), 3);
    assert.match(await hostPage.locator('input[aria-label="P2 guest link"]').inputValue(), /slot=slottoken2/);
    await hostPage.getByRole("button", { name: "Start capture" }).click();
    await hostPage.waitForFunction(() => window.__smashHostStats?.().capturedTracks.some(track => track.kind === "video" && track.readyState === "live"), null, { timeout: 10_000 });

    const guestPage = await context.newPage();
    guestPage.setDefaultTimeout(10_000); guestPage.setDefaultNavigationTimeout(15_000);
    await guestPage.goto(`http://127.0.0.1:${roomServer.address().port}/host?guest=1`, { timeout: 15_000 });
    await guestPage.evaluate(() => {
      window.guestTrackReceived = false;
      window.guestVideoTrack = null;
      window.guestPc = new RTCPeerConnection({ iceServers: [] });
      window.guestPc.addEventListener("track", event => { if (event.track.kind === "video") { window.guestTrackReceived = true; window.guestVideoTrack = event.track; } });
      window.guestPc.addEventListener("datachannel", event => {
        window.guestChannel = event.channel;
        event.channel.addEventListener("open", () => event.channel.send(JSON.stringify({ seq: 1, t: 4.5, buttons: 32768, sx: 10, sy: -10 })));
      });
      window.guestSocket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?room=room12345678&role=guest&token=slottoken2123456&port=2`);
      window.guestSocket.addEventListener("message", async event => {
        const message = JSON.parse(event.data);
        if (message.type === "offer") {
          await window.guestPc.setRemoteDescription({ type: "offer", sdp: message.sdp });
          const answer = await window.guestPc.createAnswer();
          await window.guestPc.setLocalDescription(answer);
          window.guestSocket.send(JSON.stringify({ type: "answer", port: 2, sdp: window.guestPc.localDescription.sdp }));
        } else if (message.type === "ice") await window.guestPc.addIceCandidate(message.candidate).catch(() => {});
      });
      window.guestPc.addEventListener("icecandidate", event => {
        if (event.candidate) window.guestSocket.send(JSON.stringify({ type: "ice", port: 2, candidate: event.candidate.toJSON() }));
      });
    }, { timeout: 10_000 });
    await guestPage.waitForFunction(() => window.guestTrackReceived, null, { timeout: 15_000 });
    await guestPage.waitForFunction(() => window.guestChannel?.readyState === "open", null, { timeout: 15_000 });
    await hostPage.waitForFunction(() => window.__smashHostStats().peers[2]?.dataChannel === "open", null, { timeout: 15_000 });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !sidecarMessages.some(message => message.type === "slot:input" && message.port === 2 && message.input?.buttons === 32768 && message.input?.sx === 10)) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const input = sidecarMessages.find(message => message.type === "slot:input" && message.port === 2 && message.input?.buttons === 32768 && message.input?.sx === 10);
    assert.equal(roomCount, 1);
    assert.ok(input, "mock sidecar receives slot:input");
    assert.equal(input.input.sx, 10);
    assert.equal(input.input.sy, -10);
    assert.equal(input.connectionId, connectionId);

    const originalTrackId = await hostPage.evaluate(() => document.querySelector("#preview").srcObject.getVideoTracks()[0].id);
    await hostPage.evaluate(() => {
      const track = document.querySelector("#preview").srcObject.getVideoTracks()[0];
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    const resumeButton = hostPage.getByRole("button", { name: "Resume capture" });
    await resumeButton.waitFor({ state: "visible" });
    assert.equal(await resumeButton.isEnabled(), true, "capture recovery button is enabled");
    await resumeButton.click();
    await hostPage.waitForFunction(originalTrackId => {
      const stats = window.__smashHostStats();
      return stats.video.captured && stats.peers[2]?.videoTrackId && stats.peers[2].videoTrackId !== originalTrackId && stats.peers[2].dataChannel === "open";
    }, originalTrackId, { timeout: 10_000 });
    const replacement = await hostPage.evaluate(() => ({
      captureTrackId: document.querySelector("#preview").srcObject.getVideoTracks()[0].id,
      senderTrackId: window.__smashHostStats().peers[2].videoTrackId,
    }));
    assert.equal(replacement.senderTrackId, replacement.captureTrackId, "existing peer sender uses the replacement capture track");
    assert.equal(await guestPage.evaluate(() => guestPc.connectionState), "connected", "guest stays connected during capture recovery");

    const beforeReload = await hostPage.evaluate(() => ({
      room: JSON.parse(sessionStorage.getItem("smash-host-room")).room,
      p2: document.querySelector('input[aria-label="P2 guest link"]').value,
    }));
    await guestPage.close();
    await hostPage.reload();
    const startCaptureButton = hostPage.getByRole("button", { name: "Start capture" });
    await startCaptureButton.waitFor({ state: "visible" });
    assert.equal(await startCaptureButton.isEnabled(), true);
    const afterReload = await hostPage.evaluate(() => ({
      room: window.__smashHostStats().room,
      p2: document.querySelector('input[aria-label="P2 guest link"]').value,
    }));
    assert.equal(afterReload.room, beforeReload.room, "reload reattaches to the existing room");
    assert.equal(afterReload.p2, beforeReload.p2, "reload preserves guest links");
    await hostPage.waitForFunction(() => window.__smashHostStats().signalingState === WebSocket.OPEN, null, { timeout: 10_000 });
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    for (const socket of clients) socket.terminate();
    await new Promise(resolve => sidecarServer?.close(() => resolve()) ?? resolve());
    await new Promise(resolve => roomServer?.close(() => resolve()) ?? resolve());
  }
});
