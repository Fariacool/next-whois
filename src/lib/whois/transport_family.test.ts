import type { LookupAddress } from "node:dns";
import net, { type LookupFunction, type TcpNetConnectOpts } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPSTREAM_TIMEOUT_MS } from "./config";
import { UpstreamScheduler } from "./scheduler";
import { RegistrationTransport } from "./transport";

const connect = vi.hoisted(() => vi.fn());
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  connect,
}));

afterEach(() => {
  connect.mockReset();
  vi.restoreAllMocks();
});

const ipv4 = { address: "127.0.0.1", family: 4 };
const ipv6 = { address: "::1", family: 6 };
const raw = "Domain Name: EXAMPLE.COM\r\nRegistrar: Fixture Registrar\r\n";
const host = "whois.registry.example";

async function fixture(
  family: 4 | 6,
  reply: (socket: net.Socket) => void = (socket) => socket.end(raw),
) {
  const queries: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let query = "";
    socket.on("data", (chunk: string) => {
      query += chunk;
      if (!query.endsWith("\r\n")) return;
      queries.push(query);
      reply(socket);
    });
  });
  server.listen({
    host: family === 6 ? ipv6.address : ipv4.address,
    port: 0,
    ipv6Only: true,
  });
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    queries,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function route(port: number, addresses: LookupAddress[]) {
  const failedFamilies: number[] = [];
  const lookup: LookupFunction = (_host, options, callback) => {
    // Honor family/all so forcing IPv4 or dropping fallback breaks these tests.
    const matching = addresses.filter(
      (address) => !options.family || address.family === options.family,
    );
    queueMicrotask(() => {
      if (!matching.length) {
        callback(
          Object.assign(new Error("No fixture address"), { code: "ENOTFOUND" }),
          "",
          0,
        );
      } else if (options.all) {
        callback(null, matching);
      } else {
        callback(null, matching[0].address, matching[0].family);
      }
    });
  };
  connect.mockImplementation(
    (options: TcpNetConnectOpts, listener?: () => void) => {
      expect(options.host).toBe(host);
      expect(options.port).toBe(43);
      const socket = net.connect({ ...options, port, lookup }, listener);
      socket.on("connectionAttemptFailed", (_address, _port, family) => {
        failedFamilies.push(family);
      });
      return socket;
    },
  );
  return failedFamilies;
}

describe("WHOIS address family fallback", () => {
  it.each([
    {
      name: "falls back from IPv4 to IPv6",
      family: 6 as const,
      addresses: [ipv4, ipv6],
    },
    {
      name: "falls back from IPv6 to IPv4",
      family: 4 as const,
      addresses: [ipv6, ipv4],
    },
    {
      name: "queries IPv4-only registries",
      family: 4 as const,
      addresses: [ipv4],
    },
    {
      name: "queries IPv6-only registries",
      family: 6 as const,
      addresses: [ipv6],
    },
  ])("$name", async ({ family, addresses }) => {
    const upstream = await fixture(family);
    try {
      const failed = route(upstream.port, addresses);
      const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
      await expect(
        transport.whois(host, "example.com", AbortSignal.timeout(3_000)),
      ).resolves.toBe(raw);
      expect(upstream.queries).toEqual(["example.com\r\n"]);
      expect(failed).toEqual(addresses.length > 1 ? [addresses[0].family] : []);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await upstream.close();
    }
  });

  it("reports all-family failure and releases the scheduler permit", async () => {
    const closed = await fixture(4);
    await closed.close();
    const failed = route(closed.port, [ipv4, ipv6]);
    const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
    await expect(
      transport.whois(host, "example.com", AbortSignal.timeout(3_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    expect(failed).toEqual([4, 6]);

    const upstream = await fixture(4);
    try {
      route(upstream.port, [ipv4]);
      await expect(
        transport.whois(host, "example.com", AbortSignal.timeout(3_000)),
      ).resolves.toBe(raw);
    } finally {
      await upstream.close();
    }
  });

  it.each(["caller cancellation", "upstream deadline"])(
    "keeps one deadline and releases the permit after %s during a slow response",
    async (reason) => {
      let received!: () => void;
      const queryReceived = new Promise<void>((resolve) => {
        received = resolve;
      });
      const upstream = await fixture(6, () => received());
      const caller = new AbortController();
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(deadline.signal);
      try {
        const failed = route(upstream.port, [ipv4, ipv6]);
        const transport = new RegistrationTransport(
          new UpstreamScheduler(1, 1),
        );
        const lookup = transport.whois(host, "example.com", caller.signal);
        const rejected = expect(lookup).rejects.toMatchObject({
          code: "LOOKUP_TIMEOUT",
        });
        await queryReceived;
        expect(failed).toEqual([4]);
        expect(timeout).toHaveBeenCalledExactlyOnceWith(UPSTREAM_TIMEOUT_MS);
        expect(connect).toHaveBeenCalledOnce();
        (reason === "caller cancellation" ? caller : deadline).abort();
        await rejected;

        timeout.mockRestore();
        const healthy = await fixture(4);
        try {
          route(healthy.port, [ipv4]);
          await expect(
            transport.whois(host, "example.com", AbortSignal.timeout(3_000)),
          ).resolves.toBe(raw);
        } finally {
          await healthy.close();
        }
      } finally {
        caller.abort();
        await upstream.close();
      }
    },
  );

  it("honors the connected server's cooldown without retrying another family", async () => {
    const upstream = await fixture(6, (socket) =>
      socket.end("% Query limit exceeded\r\n"),
    );
    try {
      const failed = route(upstream.port, [ipv4, ipv6]);
      const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
      for (let i = 0; i < 2; i++) {
        await expect(
          transport.whois(host, "example.com", AbortSignal.timeout(3_000)),
        ).rejects.toMatchObject({
          code: "UPSTREAM_RATE_LIMITED",
          retryAfterSeconds: 60,
        });
      }
      expect(failed).toEqual([4]);
      expect(upstream.queries).toEqual(["example.com\r\n"]);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await upstream.close();
    }
  });
});
