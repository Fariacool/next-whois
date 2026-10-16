import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistrationTransport, retryAfterSeconds } from "./transport";
import { UpstreamScheduler } from "./scheduler";

afterEach(() => vi.unstubAllGlobals());

describe("scheduled HTTP transport", () => {
  it("holds the host permit until the body is consumed while other hosts can run", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = new RegistrationTransport(new UpstreamScheduler(2, 1));
    const first = transport.json(
      "https://a.example/one",
      AbortSignal.timeout(1_000),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce(), {
      interval: 1,
    });
    const firstBody = body;
    const queued = transport.json(
      "https://a.example/two",
      AbortSignal.timeout(1_000),
    );
    fetcher.mockImplementation(async () => Response.json({ ok: true }));
    const other = transport.json(
      "https://b.example/one",
      AbortSignal.timeout(1_000),
    );
    await other;
    expect(fetcher).toHaveBeenCalledTimes(2);
    firstBody.enqueue(new TextEncoder().encode('{"ok":true}'));
    firstBody.close();
    await Promise.all([first, queued]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("releases permits before redirects, validates URLs and caps redirect loops", async () => {
    const fetcher = vi.fn(async (url: URL) =>
      url.hostname === "a.example"
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://b.example/record" },
          })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
    expect(
      await transport.json("https://a.example/", AbortSignal.timeout(1_000)),
    ).toMatchObject({ status: 200, server: "https://b.example/record" });
    await expect(
      transport.json("http://a.example/", AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    fetcher.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://a.example/" },
        }),
    );
    await expect(
      transport.json("https://a.example/", AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
  });

  it("honors Retry-After and rejects follow-up calls without opening a connection", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
    for (let i = 0; i < 2; i++)
      await expect(
        transport.json("https://a.example/", AbortSignal.timeout(1_000)),
      ).rejects.toMatchObject({
        code: "UPSTREAM_RATE_LIMITED",
        retryAfterSeconds: 120,
      });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(retryAfterSeconds("Thu, 01 Jan 1970 00:01:00 GMT", 0)).toBe(60);
    expect(retryAfterSeconds("invalid")).toBe(60);
  });

  it("bounds response bodies and releases permits after malformed JSON", async () => {
    const fetcher = vi.fn(
      async () => new Response("x".repeat(1_024 * 1_024 + 1)),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = new RegistrationTransport(new UpstreamScheduler(1, 1));
    await expect(
      transport.json("https://a.example/", AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    fetcher.mockImplementation(async () => new Response("{invalid"));
    await expect(
      transport.json("https://a.example/", AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    fetcher.mockImplementation(async () => Response.json({ ok: true }));
    await expect(
      transport.json("https://a.example/", AbortSignal.timeout(1_000)),
    ).resolves.toMatchObject({ status: 200 });
  });
});
