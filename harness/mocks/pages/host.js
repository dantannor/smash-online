const pageParams = new URL(location.href).searchParams;
const room = pageParams.get("room");
let dropFirstActiveInput = pageParams.get("dropFirstInput") === "1";
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
let frame = 0;
const frameTimes = [];
function draw() {
  const timestamp = performance.timeOrigin + performance.now();
  ctx.fillStyle = "#222"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "white"; ctx.fillText(`frame ${frame}`, 8, 30);
  const view = new DataView(new ArrayBuffer(12)); view.setUint32(0, frame); view.setFloat64(4, timestamp);
  for (let bit = 0; bit < 96; bit++) { ctx.fillStyle = (view.getUint8(bit >> 3) >> (7 - (bit & 7))) & 1 ? "white" : "black"; ctx.fillRect(bit, 0, 1, 12); }
  frameTimes.push(timestamp); if (frameTimes.length > 120) frameTimes.shift();
  frame++; requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
const sidecar = new WebSocket(window.__SMASH_MOCK_SIDECAR_URL__ || "ws://127.0.0.1:8765");
const socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws?room=${room}&role=host&token=mock-room-token-00000000000000000001`);
const peers = new Map();
const sourceStream = canvas.captureStream(60);
const stats = { sidecarReady: false, framesPerSecond: 0 };
setInterval(() => { stats.framesPerSecond = frameTimes.length > 1 ? 1000 * (frameTimes.length - 1) / (frameTimes.at(-1) - frameTimes[0]) : 0; }, 1000);
function send(message) { if (sidecar.readyState === WebSocket.OPEN) sidecar.send(JSON.stringify(message)); }
sidecar.addEventListener("message", (event) => { const msg = JSON.parse(event.data); if (msg.type === "ready") stats.sidecarReady = true; });
socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "slot:connected") {
    const { port, connectionId } = message;
    const old = peers.get(port); old?.pc.close();
    send({ type: "slot:connect", port, connectionId });
    const pc = new RTCPeerConnection({ iceServers: [] }); peers.set(port, { pc, connectionId });
    pc.addEventListener("icecandidate", ({ candidate }) => { if (candidate) socket.send(JSON.stringify({ type: "ice", port, candidate })); });
    for (const track of sourceStream.getTracks()) pc.addTrack(track, sourceStream);
    const channel = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
    channel.addEventListener("message", (ev) => {
      let input; try { input = JSON.parse(ev.data); } catch { return; }
      if (dropFirstActiveInput && (input.buttons !== 0 || input.sx !== 0 || input.sy !== 0)) {
        dropFirstActiveInput = false;
        return;
      }
      send({ type: "slot:input", port, connectionId, input });
    });
    await pc.setLocalDescription(await pc.createOffer());
    socket.send(JSON.stringify({ type: "offer", port, sdp: pc.localDescription }));
  } else if (message.type === "slot:disconnected") {
    const peer = peers.get(message.port); if (peer?.connectionId === message.connectionId) { peer.pc.close(); peers.delete(message.port); send({ type: "slot:disconnect", port: message.port, connectionId: message.connectionId }); }
  } else if (message.type === "answer") {
    const peer = peers.get(message.port); if (peer) await peer.pc.setRemoteDescription(message.sdp);
  } else if (message.type === "ice") {
    const peer = peers.get(message.port); if (peer && message.candidate) await peer.pc.addIceCandidate(message.candidate);
  }
});
window.__smashHostStats = async () => {
  const reports = await Promise.all([...peers.values()].map(({ pc }) => pc.getStats()));
  return { ...stats, frame, frameTimes: [...frameTimes], rtcStats: reports.flatMap((report) => [...report.values()]) };
};
