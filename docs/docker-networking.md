# Docker IPv4/IPv6 networking

## Prerequisites and behavior

Docker Compose attaches the app to the `dualstack` bridge. Its name is
`${COMPOSE_NETWORK_NAME:-next-whois}_dualstack`, so the default is
`next-whois_dualstack`. IPv4 remains enabled and `enable_ipv6: true` adds IPv6.
Docker Engine 27+ allocates an IPv6 subnet automatically, using a unique local
`/64` when no IPv6 address pool is configured. No fixed subnet or Dockerfile
change is needed. See [Docker IPv6 networking](https://docs.docker.com/engine/daemon/ipv6/)
and [Engine 27 networking changes](https://docs.docker.com/engine/release-notes/27/).

WHOIS TCP connections use Node's `autoSelectFamily` with a 250 ms attempt
timeout before trying the next address. All attempts belong to the same
upstream hostname and share the existing 5-second deadline and scheduler
permit. This applies to registry queries, IANA discovery, registrar referrals,
and IP/ASN queries. IPv4-only upstreams and hosts remain supported. The
fallback only handles connection establishment; it does not retry a connected
server's response, bypass cooldowns, or fix slow reads. RDAP continues to use
the existing HTTPS `fetch` transport. See
[Node connection options](https://nodejs.org/docs/latest-v22.x/api/net.html#socketconnectoptions-connectlistener).

IPv6 Internet access also requires a working host IPv6 route, forwarding and
Docker-managed firewall/NAT rules. Docker's iptables backend normally manages
forwarding; its nftables backend requires forwarding to be enabled separately.
This repository does not edit host sysctls, firewall rules or daemon settings.
Creating the network can cause Docker itself to enable forwarding and install
firewall rules. See [Docker packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

The published HTTP port keeps the configured `HOST_BIND_ADDRESS` (IPv4 by
default). Outbound dual-stack connectivity does not require changing that
binding or the app's `HOSTNAME=0.0.0.0` listener. Querying an IPv6 address also
does not itself require an IPv6 connection to the registry.

## Upgrade an existing IPv4-only stack

Wait for **Build and Push Docker Image** to finish successfully for the new
commit, including publication of the combined `linux/amd64` and `linux/arm64`
manifest. Until then, `latest` can still refer to the previous image.

1. Sync the new `docker-compose.yml` and `compose` script to the deployment
   directory. For a clean clone tracking `main`, run `git pull --ff-only`.
2. Keep your current `.env`; do not replace it with `.env.example`.
   `COMPOSE_NETWORK_NAME` is now the base name of the new bridge. An existing
   value such as `next-whois` produces `next-whois_dualstack` automatically.
3. Run `./compose validate`, then `./compose upgrade`. This pulls the image,
   creates the dual-stack network and recreates the app, causing a brief
   interruption. There is no need to run `down` or remove the old network first.
4. If a reverse proxy, Redis or another container used the old network to
   reach the app (or vice versa), attach that container to the new network and
   persist the change in its own deployment configuration. Host reverse
   proxies using the published port and host Redis using
   `host.docker.internal` continue to use their existing paths. Keep the old
   network while any other containers still depend on it.
5. Verify the new network and a fresh lookup as shown below.

The separate network identity avoids changing an existing IPv4-only bridge
in place. Pulling the image alone, running `./compose restart`, or upgrading
with the old Compose file does not enable container IPv6. Routine future
image updates can use `./compose upgrade` with this new configuration.

To pin the application version, set
`IMAGE_NAME=ghcr.io/fariacool/next-whois:sha-<full commit SHA>` in `.env` before
running `./compose upgrade`. An older application image can also run on the
new network; restoring the old network layout requires its old Compose file
and recreating the app as well.

## Verify after deployment

These commands inspect the running configuration without printing application
environment values or credentials:

```bash
docker compose --env-file .env --file docker-compose.yml exec -T app node -e '
const os = require("node:os");
console.log(os.networkInterfaces());
'
docker inspect "$(docker compose --env-file .env --file docker-compose.yml ps -q app)" \
  --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} IPv4={{$network.IPAddress}} IPv6={{$network.GlobalIPv6Address}}{{println}}{{end}}'
```

Check the actual network name printed above (replace the default if you use
a custom `COMPOSE_NETWORK_NAME`):

```bash
docker network inspect next-whois_dualstack \
  --format '{{.EnableIPv6}} {{json .IPAM.Config}}'
```

Try the same connection options used by the WHOIS transport:

```bash
docker compose --env-file .env --file docker-compose.yml exec -T app node -e '
const net = require("node:net");
const started = Date.now();
const socket = net.connect({
  host: "whois.dns.pt", port: 43, autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250, signal: AbortSignal.timeout(5000)
}, () => {
  console.log({family: socket.remoteFamily, elapsedMs: Date.now() - started});
  socket.destroy();
});
socket.on("error", error => { console.error(error.code); process.exitCode = 1; });
'
```

This can succeed over IPv4 or IPv6. To test the IPv6 route specifically, replace
`autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250` with `family: 6`.
Upstream DNS and availability can change; a successful connection alone does
not prove a lookup returns usable registration data. Follow it with one fresh
`/api/lookup` request using your configured authentication. Check that the
response has `cached: false`; a cache hit does not verify upstream connectivity.

## Offline regression tests

`pnpm test` includes local TCP fixtures for IPv4-to-IPv6 and IPv6-to-IPv4
fallback, single-family registries, failure, cancellation, the shared upstream
deadline and rate-limit cooldowns. These tests do not contact public registries
or prove that a deployment host has working IPv6 Internet access.

Before publishing the shared image tags, CI also starts the built image with
the actual Compose file on both native architectures. Its container smoke
test checks that the bridge enables IPv6 and the app has both an IPv4 address
and an IPv6 address beyond link-local, alongside the existing HTTP checks.
