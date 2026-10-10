# Running the signaling server

Requires Node.js 20 or newer. From the repository root:

```sh
npm install
npm start
```

The server listens on `0.0.0.0:8787` by default. Set `PORT` to change the port and `HOST=127.0.0.1` to bind only to loopback. In another terminal, run `server/tunnel.sh` to start a Cloudflare quick tunnel. The command prints a public `https://…trycloudflare.com` URL; keep it running while clients use the server.

Quick tunnels are for testing, not production: the URL is randomly assigned and changes each run, and there is no SLA. No Cloudflare account or paid feature is needed. Stop the tunnel with Ctrl-C, and stop the server with Ctrl-C.

## Connectivity limits

The server returns public STUN addresses only; it does not relay media or game traffic. Guests behind symmetric NAT, restrictive firewalls, or client-isolated Wi-Fi may fail to establish a direct WebRTC peer connection. In that case a TURN relay is needed. Free options exist without creating an account, including public community-operated TURN servers, but availability, privacy, and reliability are not guaranteed. Do not put untrusted public TURN credentials into a shared or production deployment. A self-hosted coturn relay is another option, but requires operating infrastructure.
