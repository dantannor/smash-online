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
  // Slot claims for the current room. A port is taken while a guest is connected or it was claimed in the last 90 s; a
  // returning client (same token) always gets its own port back unless somebody else has since taken it.
  async claim({ room, client, port, connected }) {
    const TTL = 90_000, now = Date.now();
    let claims = (await this.ctx.storage.get("claims")) ?? { room, byPort: {} };
    if (claims.room !== room) claims = { room, byPort: {} };
    const taken = (p) => connected.includes(p) || (claims.byPort[p] && now - claims.byPort[p].at < TTL && claims.byPort[p].client !== client);
    let chosen = null;
    if (port) chosen = port;                                                       // permanent P1/friend links name their port
    else {
      const own = Object.entries(claims.byPort).find(([, v]) => v.client === client);
      if (own) chosen = Number(own[0]);                                              // a reload or a return: keep the same slot
      else chosen = [1, 2, 3, 4].find((p) => !taken(p)) ?? null;
    }
    if (chosen !== null) {
      for (const [p, v] of Object.entries(claims.byPort)) if (v.client === client && Number(p) !== chosen) delete claims.byPort[p];
      claims.byPort[chosen] = { client, at: now };
    }
    await this.ctx.storage.put("claims", claims);
    return chosen;
  }
  async clear() { await this.ctx.storage.delete("current"); await this.ctx.storage.delete("claims"); }
}
