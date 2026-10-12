import { DurableObject } from "cloudflare:workers";

// One global instance: the room the VM registered after it booted (slot tokens per port). The Worker maps the permanent
// P1 / friend URLs onto it. Whether it is still current is decided by comparing `boot` with the instance's lastStartTimestamp.
export class Registry extends DurableObject {
  async register({ room, boot, slots }) {
    await this.ctx.storage.put("current", { room, boot, slots, at: Date.now() });
  }
  async current() { return (await this.ctx.storage.get("current")) ?? null; }
  // Wake history (newest last, 30 kept): what the Worker did on each /go poll that changed the VM, for diagnosing slow starts.
  async logWake(entry) {
    const list = (await this.ctx.storage.get("wakes")) ?? [];
    list.push({ at: Date.now(), ...entry });
    await this.ctx.storage.put("wakes", list.slice(-30));
  }
  async wakes() { return (await this.ctx.storage.get("wakes")) ?? []; }
  async clear() { await this.ctx.storage.delete("current"); }
}
