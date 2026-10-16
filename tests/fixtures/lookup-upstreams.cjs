// Test-only preload. Production never imports this file or reads fixture switches.
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const send = (message) => {
  if (process.connected) process.send(message);
};
const active = new Map();
let total = 0;
function start(host) {
  active.set(host, (active.get(host) || 0) + 1);
  send({ type: "start", host, total: ++total, perHost: active.get(host) });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active.set(host, active.get(host) - 1);
    send({ type: "end", host, total: --total, perHost: active.get(host) });
  };
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return nativeFetch(input, init);
  if (url.hostname === "www.nazhumi.com")
    return Response.json({ data: { price: [] } });
  const finish = start(url.hostname);
  const name = url.pathname.split("/").at(-1);
  send({ type: "query", protocol: "rdap", host: url.hostname, query: name });
  try {
    await delay(name.startsWith("slowrdap") ? 6500 : 35, undefined, {
      signal: init?.signal,
    });
    if (url.hostname === "data.iana.org") {
      const kind = name.replace(".json", "");
      const services =
        kind === "dns"
          ? [
              [["com", "de", "uk"], ["https://rdap.com.fixture.example/"]],
              [["net"], ["https://rdap.net.fixture.example/"]],
              [["org"], ["https://limited.fixture.example/"]],
            ]
          : [
              [
                [
                  kind === "ipv4"
                    ? "0.0.0.0/0"
                    : kind === "ipv6"
                      ? "::/0"
                      : "0-4294967295",
                ],
                ["https://rdap.ip.fixture.example/"],
              ],
            ];
      return Response.json({ services });
    }
    if (url.hostname === "limited.fixture.example")
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    if (name.startsWith("missing")) return new Response(null, { status: 404 });
    if (/^(fallback|timeoutwhois)/.test(name))
      return new Response(null, { status: 503 });
    if (name.startsWith("malformed"))
      return Response.json({ objectClassName: "entity" });
    if (
      name.startsWith("redirect") &&
      url.hostname !== "redirect.fixture.example"
    )
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://redirect.fixture.example/domain/${name}`,
        },
      });
    if (url.pathname.includes("/ip/")) {
      const ip = url.pathname.split("/ip/")[1].split("/")[0];
      return Response.json({
        objectClassName: "ip network",
        startAddress: ip.includes(":") ? "::" : "0.0.0.0",
        endAddress: ip.includes(":")
          ? "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
          : "255.255.255.255",
        ipVersion: ip.includes(":") ? "v6" : "v4",
        name: "Fixture network",
      });
    }
    if (url.pathname.includes("/autnum/"))
      return Response.json({
        objectClassName: "autnum",
        startAutnum: Number(name),
        endAutnum: Number(name),
        name: "Fixture ASN",
      });
    if (!url.hostname.endsWith(".fixture.example"))
      throw new Error(`Unexpected outbound host: ${url.hostname}`);
    return Response.json({
      objectClassName: "domain",
      ldhName: name.toUpperCase(),
      status: ["active"],
      events: [
        { eventAction: "registration", eventDate: "2000-01-02T03:04:05Z" },
      ],
      nameservers: [{ ldhName: "NS1.EXAMPLE.COM" }],
    });
  } finally {
    finish();
  }
};
const fixture = net.createServer((socket) => {
  let buffer = "";
  let received = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (received || !buffer.endsWith("\r\n")) return;
    received = true;
    const [host, query] = buffer
      .trim()
      .split("\n")
      .map((line) => line.trim());
    send({ type: "query", protocol: "whois", host, query });
    if (host === "whois.iana.org")
      return socket.end(
        `domain: ${query.toUpperCase()}\nwhois: whois.registry.fixture.example\n`,
      );
    if (query.startsWith("timeoutwhois")) return;
    if (query.startsWith("whois-rate"))
      return socket.end("% Query limit exceeded\n");
    if (query.startsWith("missing"))
      return socket.end(`No match for "${query}".\n`);
    if (query.startsWith("malformed"))
      return socket.end("No useful registration data\n");
    if (host === "whois.ja.net")
      return socket.end(
        readFileSync(
          join(__dirname, "../../src/lib/whois/fixtures/jisc.txt"),
          "utf8",
        ).replace(/abdn\.ac\.uk/gi, query),
      );
    setTimeout(
      () =>
        socket.end(
          `Domain Name: ${query.toUpperCase()}\nRegistrar: Fixture Registrar\nCreation Date: 2001-02-03T00:00:00Z\n${host === "whois.registry.fixture.example" ? "Registrar WHOIS Server: whois.registrar.fixture.example\n" : ""}`,
        ),
      35,
    );
  });
  socket.on("error", () => {});
});
fixture.listen(0, "127.0.0.1");
fixture.unref();
const nativeConnect = net.connect;
net.connect = function (options, listener) {
  if (options && typeof options === "object" && options.port === 43) {
    const finish = start(options.host);
    const socket = nativeConnect(
      { ...options, host: "127.0.0.1", port: fixture.address().port },
      () => {
        socket.write(`${options.host}\n`);
        listener?.();
      },
    );
    socket.on("close", finish);
    return socket;
  }
  return nativeConnect.apply(this, arguments);
};
syncBuiltinESMExports();
