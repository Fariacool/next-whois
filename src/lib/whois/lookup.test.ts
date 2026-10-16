import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupRawWhois } from "./whois_client";
import { LookupError } from "./errors";
import { lookupRdap } from "./rdap_client";
import { lookupWhois, lookupWhoisWithCache } from "./lookup";
import { getJsonRedisValue, setJsonRedisValue } from "@/lib/server/redis";

vi.mock("./whois_client", () => ({ lookupRawWhois: vi.fn() }));
vi.mock("./rdap_client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rdap_client")>()),
  lookupRdap: vi.fn(),
}));
vi.mock("@/lib/server/redis", () => ({
  getJsonRedisValue: vi.fn(),
  setJsonRedisValue: vi.fn(),
}));
vi.mock("@/lib/pricing/client", () => ({
  getDomainPricing: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/moz/client", () => ({
  getMozMetrics: vi
    .fn()
    .mockResolvedValue({ domainAuthority: 0, pageAuthority: 0, spamScore: 0 }),
}));

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const response = (raw: string) => ({ raw, server: "registry.example" });

beforeEach(() => {
  vi.clearAllMocks();
  delete (
    globalThis as typeof globalThis & { nextWhoisLookupService?: unknown }
  ).nextWhoisLookupService;
  vi.mocked(lookupRdap).mockRejectedValue(new Error("RDAP unavailable"));
  vi.mocked(getJsonRedisValue).mockResolvedValue(null);
  vi.mocked(lookupRawWhois).mockResolvedValue(
    response("Domain Name: example.com\nRegistrar: Example Registrar"),
  );
});

describe("registry routing and partial results", () => {
  it.each([
    ["au", "13cabs.com.au", "Unknown"],
    ["il", "019mobile.co.il", "2014-10-02T00:00:00.000Z"],
    ["pe", "abril.pe", "Unknown"],
    ["lv", "1a.lv", "Unknown"],
  ])(
    "returns a compatible successful response for %s",
    async (name, domain, creationDate) => {
      vi.mocked(lookupRawWhois).mockResolvedValue(response(fixture(name)));
      const result = await lookupWhois(domain);
      expect(result.status).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ domain, creationDate });
      expect(result.result!.registrar).not.toBe("Unknown");
    },
  );

  it("uses Jisc directly for .ac.uk instead of the ordinary .uk path", async () => {
    vi.mocked(lookupRawWhois).mockResolvedValue({
      raw: fixture("jisc"),
      server: "whois.ja.net",
    });
    const result = await lookupWhois("https://www.abdn.ac.uk/research");
    expect(lookupRawWhois).toHaveBeenCalledWith(
      { kind: "domain", value: "abdn.ac.uk" },
      expect.any(AbortSignal),
    );
    expect(lookupRdap).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: true,
      source: "whois",
      result: {
        domain: "abdn.ac.uk",
        whoisServer: "whois.ja.net",
        creationDate: "2003-09-18T00:00:00.000Z",
      },
    });
  });

  it("preserves the ordinary lookup path for other .uk domains", async () => {
    await lookupWhois("example.co.uk");
    expect(lookupRawWhois).toHaveBeenCalledWith(
      { kind: "domain", value: "example.co.uk" },
      expect.any(AbortSignal),
    );
    expect(lookupRdap).toHaveBeenCalledWith(
      "example.co.uk",
      expect.any(AbortSignal),
    );
  });

  it("normalizes an authoritative Jisc missing-name response for existing clients", async () => {
    vi.mocked(lookupRawWhois).mockResolvedValue(
      response("No such domain nonexistent.ac.uk\n"),
    );
    expect(await lookupWhois("nonexistent.ac.uk")).toMatchObject({
      status: false,
      error:
        'No match for domain "nonexistent.ac.uk" (Jisc: No such domain nonexistent.ac.uk)',
    });
  });

  it.each(["digital.nhs.uk", "https://111.nhs.uk/", "DIGITAL.NHS.UK."])(
    "does not mistake a non-authoritative NHS response for non-registration: %s",
    async (query) => {
      const result = await lookupWhois(query);
      expect(result).toMatchObject({
        status: false,
        error:
          "Unsupported WHOIS/RDAP namespace: NHS-managed .nhs.uk subdomains",
      });
      expect(lookupRawWhois).not.toHaveBeenCalled();
      expect(lookupRdap).not.toHaveBeenCalled();
    },
  );

  it("keeps status-only information usable when dates are invalid", async () => {
    vi.mocked(lookupRawWhois).mockResolvedValue(
      response(
        "Status: active\nCreation Date: 2020-02-30\nUpdated Date: Managing Registrar 20201224",
      ),
    );
    const result = await lookupWhois("example.com");
    expect(result).toMatchObject({
      status: true,
      result: {
        domain: "example.com",
        creationDate: "Unknown",
        updatedDate: "Unknown",
        expirationDate: "Unknown",
        domainAge: null,
        remainingDays: null,
      },
    });
  });

  it.each([
    "WHOIS LIMIT EXCEEDED",
    "No match for example.com",
    "\n% Updated Date: 2020-12-24\n",
  ])("retains errors for unsuccessful queries: %s", async (raw) => {
    vi.mocked(lookupRawWhois).mockResolvedValue(response(raw));
    expect((await lookupWhois("example.com")).status).toBe(false);
  });

  it("does not interpret legal comments as a lookup error", async () => {
    vi.mocked(lookupRawWhois).mockResolvedValue(
      response(
        "Domain Name: example.com\nRegistrar: Example Registrar\n% If a domain is not found, contact us.",
      ),
    );
    expect((await lookupWhois("example.com")).status).toBe(true);
  });
});

describe("RDAP-first lookup and cache", () => {
  it("returns partial RDAP data without querying WHOIS to fill missing dates", async () => {
    vi.mocked(lookupRdap).mockResolvedValue({
      ldhName: "13cabs.com.au",
      events: [
        { eventAction: "last changed", eventDate: "2026-10-16T13:00:00Z <<<" },
        {
          eventAction: "last update of RDAP database",
          eventDate: "2026-10-16T13:00:00Z",
        },
      ],
    });
    vi.mocked(lookupRawWhois).mockResolvedValue(response(fixture("au")));
    const result = await lookupWhois("13cabs.com.au");
    expect(result).toMatchObject({
      status: true,
      source: "rdap",
      result: {
        creationDate: "Unknown",
        updatedDate: "Unknown",
        rawWhoisContent: "",
        expirationDate: "Unknown",
      },
    });
  });

  it("does not merge an unsuccessful WHOIS response into valid RDAP data", async () => {
    vi.mocked(lookupRdap).mockResolvedValue({ ldhName: "example.com" });
    vi.mocked(lookupRawWhois).mockResolvedValue(
      response("No match for example.com\nUpdated Date: 2020-12-24"),
    );
    expect((await lookupWhois("example.com")).result?.updatedDate).toBe(
      "Unknown",
    );
    expect(lookupRawWhois).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { errorCode: 404 },
    { ldhName: "other.com" },
    { ldhName: "example.com", nameservers: "invalid" },
  ])("falls back for absent or malformed RDAP: %j", async (data) => {
    vi.mocked(lookupRdap).mockResolvedValue(data);
    const result = await lookupWhois("example.com");
    expect(result).toMatchObject({ status: true, source: "whois" });
    expect(lookupRawWhois).toHaveBeenCalledOnce();
  });

  it("does not send WHOIS until RDAP has failed", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(lookupRdap).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const lookup = lookupWhois("example.com");
    expect(lookupRawWhois).not.toHaveBeenCalled();
    reject(new Error("RDAP unavailable"));
    expect(await lookup).toMatchObject({ status: true, source: "whois" });
  });

  it.each(["BUSY", "UPSTREAM_RATE_LIMITED"] as const)(
    "does not fall back for %s",
    async (code) => {
      vi.mocked(lookupRdap).mockRejectedValue(
        new LookupError(code, "Retry later.", 60),
      );
      expect(await lookupWhois("example.com")).toMatchObject({
        status: false,
        errorCode: code,
        retryAfterSeconds: 60,
      });
      expect(lookupRawWhois).not.toHaveBeenCalled();
    },
  );

  it("does not start WHOIS after the lookup deadline", async () => {
    const controller = new AbortController();
    vi.mocked(lookupRdap).mockImplementation(async () => {
      controller.abort();
      return null;
    });
    expect(await lookupWhois("example.com", controller.signal)).toMatchObject({
      status: false,
      errorCode: "LOOKUP_TIMEOUT",
    });
    expect(lookupRawWhois).not.toHaveBeenCalled();
  });

  it("uses a new normalized cache namespace and reuses successful results", async () => {
    const result = await lookupWhoisWithCache("Example.COM");
    expect(result.status).toBe(true);
    expect(getJsonRedisValue).toHaveBeenCalledWith("whois:v3:example.com");
    expect(setJsonRedisValue).toHaveBeenCalledWith(
      "whois:v3:example.com",
      expect.objectContaining({
        result: expect.objectContaining({ status: true }),
        expiresAt: expect.any(Number),
      }),
    );
    vi.clearAllMocks();
    expect(
      await lookupWhoisWithCache("https://www.example.com/path"),
    ).toMatchObject({ cached: true, time: 0 });
    expect(lookupRawWhois).not.toHaveBeenCalled();
  });
});
