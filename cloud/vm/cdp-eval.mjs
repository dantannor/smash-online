// Debug helper: evaluate a JS expression in the VM's host page over the Chrome DevTools port and print the result.
// usage (on the VM): node cloud/vm/cdp-eval.mjs "<expression>"
import WebSocket from "ws";
const CDP = process.env.SMASH_CDP || "http://127.0.0.1:9222";
const page = (await (await fetch(`${CDP}/json/list`)).json()).find(t => t.type === "page" && /\/host/.test(t.url));
if (!page) { console.error("host page not open"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(resolve => ws.once("open", resolve));
ws.on("message", data => {
  const m = JSON.parse(data);
  if (m.id !== 1) return;
  const out = m.result?.result?.value ?? m.result?.exceptionDetails?.text ?? m.error;
  process.stdout.write((typeof out === "string" ? out : JSON.stringify(out)) + "\n", () => process.exit(0)); // flush before exiting: pipes truncate at 64 KB otherwise
});
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], returnByValue: true, awaitPromise: true, userGesture: true } }));
setTimeout(() => { console.error("timeout"); process.exit(2); }, 20000);
