const query = new URL(location.href).searchParams;
const room = query.get("room"); const token = query.get("slot");
const join = await fetch(`${location.origin}/api/rooms/${room}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slotToken: token }) }).then((r) => r.json());
const port = join.port;
const socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws?room=${room}&role=guest&token=${token}&port=${port}`);
const video = document.querySelector("video"); let channel; let seq = 0;
const state = { connected: false, port };
const stats = { lastInputSentAt: null, received: 0 };
const pc = new RTCPeerConnection({ iceServers: [] });
pc.addEventListener("track", (event) => { video.srcObject = event.streams[0]; });
pc.addEventListener("datachannel", (event) => { channel = event.channel; channel.addEventListener("open", () => { state.connected = true; }); channel.addEventListener("close", () => { state.connected = false; }); channel.addEventListener("message", () => { stats.received++; }); });
pc.addEventListener("icecandidate", ({ candidate }) => { if (candidate) socket.send(JSON.stringify({ type: "ice", candidate })); });
socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "offer") { await pc.setRemoteDescription(message.sdp); await pc.setLocalDescription(await pc.createAnswer()); socket.send(JSON.stringify({ type: "answer", sdp: pc.localDescription })); }
  else if (message.type === "ice" && message.candidate) await pc.addIceCandidate(message.candidate);
});
let virtualInput = { buttons: 0, sx: 0, sy: 0 };
function sendInput(input) {
  const packet = { seq: seq++ >>> 0, t: performance.now(), ...input };
  stats.lastInputSentAt = performance.timeOrigin + packet.t;
  if (channel?.readyState === "open") {
    try { channel.send(JSON.stringify(packet)); } catch { /* channel may close between readiness check and send */ }
  }
  return packet;
}
function setVirtualInput(input) {
  virtualInput = { buttons: input.buttons, sx: input.sx, sy: input.sy };
  return sendInput(virtualInput);
}
setInterval(() => { if (channel?.readyState === "open") sendInput(virtualInput); }, 1000 / 60);
window.__smashGuest = { state, stats: async () => ({ ...stats, rtcStats: [...(await pc.getStats()).values()] }), get lastInput() { return stats.lastInputSentAt; }, setVirtualInput };
window.addEventListener("pagehide", () => { try { socket.close(); } catch {} try { pc.close(); } catch {} });
