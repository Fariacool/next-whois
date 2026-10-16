import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupRawWhois } from "./whois_client";
import { normalizeQuery } from "./query";
import { LookupError } from "./errors";

const { whois } = vi.hoisted(() => ({ whois: vi.fn() }));
vi.mock("./transport", () => ({ registrationTransport: () => ({ whois }) }));
vi.mock("@/lib/env", async (original) => ({
  ...(await original<typeof import("@/lib/env")>()),
  MAX_WHOIS_FOLLOW: 2,
}));
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  delete (
    globalThis as typeof globalThis & { nextWhoisServerDiscovery?: unknown }
  ).nextWhoisServerDiscovery;
});

describe("scheduled WHOIS discovery and referrals", () => {
  it.each([
    ["example.co.il", "whois.isoc.org.il"],
    ["example.pe", "kero.yachay.pe"],
    ["example.lv", "whois.nic.lv"],
  ])("uses the pinned registry for %s", async (input, host) => {
    whois.mockResolvedValue(
      `Domain Name: ${input}\nRegistrar: Fixture Registrar`,
    );
    await lookupRawWhois(normalizeQuery(input), AbortSignal.timeout(1_000));
    expect(whois).toHaveBeenCalledWith(host, input, expect.any(AbortSignal));
    expect(whois).toHaveBeenCalledOnce();
  });

  it("queries Jisc directly for delegated .ac.uk names", async () => {
    whois.mockResolvedValue(fixture("jisc"));
    expect(
      await lookupRawWhois(
        normalizeQuery("abdn.ac.uk"),
        AbortSignal.timeout(1_000),
      ),
    ).toMatchObject({ server: "whois.ja.net" });
    expect(whois).toHaveBeenCalledWith(
      "whois.ja.net",
      "abdn.ac.uk",
      expect.any(AbortSignal),
    );
  });

  it("shares IANA discovery and schedules both registry and registrar connections", async () => {
    whois.mockImplementation(async (host: string, input: string) =>
      host === "whois.iana.org"
        ? "domain: COM\nwhois: whois.registry.example\n"
        : `Domain Name: ${input}\nRegistrar: Fixture Registrar\n${host === "whois.registry.example" ? "Registrar WHOIS Server: whois.registrar.example\n" : ""}`,
    );
    const records = await Promise.all(
      ["a.com", "b.com"].map((input) =>
        lookupRawWhois(normalizeQuery(input), AbortSignal.timeout(1_000)),
      ),
    );
    expect(
      whois.mock.calls.filter(([host]) => host === "whois.iana.org"),
    ).toHaveLength(1);
    expect(
      whois.mock.calls.filter(([host]) => host === "whois.registry.example"),
    ).toHaveLength(2);
    expect(
      whois.mock.calls.filter(([host]) => host === "whois.registrar.example"),
    ).toHaveLength(2);
    expect(
      records.every((record) => record.server === "whois.registrar.example"),
    ).toBe(true);
  });

  it.each([
    ["8.8.8.8/24", "8.8.8.8", "+ n 8.8.8.8"],
    ["AS13335", "13335", "+ a 13335"],
  ])(
    "keeps %s discovery and its ARIN query inside the scheduler",
    async (input, discovery, query) => {
      whois.mockImplementation(async (host: string) =>
        host === "whois.iana.org"
          ? "whois: whois.arin.net\n"
          : "NetRange: 8.8.8.0 - 8.8.8.255",
      );
      await lookupRawWhois(normalizeQuery(input), AbortSignal.timeout(1_000));
      expect(whois).toHaveBeenCalledWith(
        "whois.iana.org",
        discovery,
        expect.any(AbortSignal),
      );
      expect(whois).toHaveBeenCalledWith(
        "whois.arin.net",
        query,
        expect.any(AbortSignal),
      );
    },
  );

  it("does not interpret a blank IANA server as the next field", async () => {
    whois.mockResolvedValue("domain: COM\nwhois:   \nstatus: ACTIVE\n");
    await expect(
      lookupRawWhois(normalizeQuery("a.com"), AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ code: "LOOKUP_FAILED" });
    expect(whois).toHaveBeenCalledOnce();
  });

  it("preserves typed transport errors swallowed by whoiser", async () => {
    whois.mockRejectedValue(
      new LookupError("UPSTREAM_RATE_LIMITED", "Retry later.", 60),
    );
    await expect(
      lookupRawWhois(normalizeQuery("example.lv"), AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterSeconds: 60,
    });
  });
});
