import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whoisDomain, whoisQuery } from "whoiser";
import { lookupRdap } from "./rdap_client";
import { lookupWhois, lookupWhoisWithCache } from "./lookup";
import { getJsonRedisValue, setJsonRedisValue } from "@/lib/server/redis";

vi.mock("whoiser", () => ({
  whoisDomain: vi.fn(),
  whoisQuery: vi.fn(),
  whoisIp: vi.fn(),
  whoisAsn: vi.fn(),
}));
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
const response = (raw: string) => ({ "registry.example": { __raw: raw } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookupRdap).mockRejectedValue(new Error("RDAP unavailable"));
  vi.mocked(getJsonRedisValue).mockResolvedValue(null);
  vi.mocked(whoisDomain).mockResolvedValue(
    response("Domain Name: example.com\nRegistrar: Example Registrar"),
  );
  vi.mocked(whoisQuery).mockResolvedValue(fixture("jisc"));
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
      vi.mocked(whoisDomain).mockResolvedValue(response(fixture(name)));
      const result = await lookupWhois(domain);
      expect(result.status).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ domain, creationDate });
      expect(result.result!.registrar).not.toBe("Unknown");
    },
  );

  it("uses Jisc directly for .ac.uk instead of the ordinary .uk path", async () => {
    const result = await lookupWhois("https://www.abdn.ac.uk/research");
    expect(whoisQuery).toHaveBeenCalledWith(
      "whois.ja.net",
      "abdn.ac.uk",
      15000,
    );
    expect(whoisDomain).not.toHaveBeenCalled();
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
    expect(whoisDomain).toHaveBeenCalledWith(
      "example.co.uk",
      expect.objectContaining({ raw: true }),
    );
    expect(lookupRdap).toHaveBeenCalledWith("example.co.uk");
    expect(whoisQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["example.co.il", "whois.isoc.org.il"],
    ["example.org.il", "whois.isoc.org.il"],
    ["example.pe", "kero.yachay.pe"],
    ["example.com.pe", "kero.yachay.pe"],
    ["example.lv", "whois.nic.lv"],
  ])(
    "queries the known registry for %s without uncached IANA discovery",
    async (domain, host) => {
      await lookupWhois(domain);
      expect(whoisDomain).toHaveBeenCalledWith(
        domain,
        expect.objectContaining({ host, raw: true, timeout: 15000 }),
      );
    },
  );

  it("normalizes an authoritative Jisc missing-name response for existing clients", async () => {
    vi.mocked(whoisQuery).mockResolvedValue(
      "No such domain nonexistent.ac.uk\n",
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
      vi.mocked(whoisQuery).mockResolvedValue(fixture("nhs-jisc"));
      const result = await lookupWhois(query);
      expect(result).toMatchObject({
        status: false,
        error:
          "Unsupported WHOIS/RDAP namespace: NHS-managed .nhs.uk subdomains",
      });
      expect(whoisQuery).not.toHaveBeenCalled();
      expect(whoisDomain).not.toHaveBeenCalled();
      expect(lookupRdap).not.toHaveBeenCalled();
    },
  );

  it("keeps status-only information usable when dates are invalid", async () => {
    vi.mocked(whoisDomain).mockResolvedValue(
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
    vi.mocked(whoisDomain).mockResolvedValue(response(raw));
    expect((await lookupWhois("example.com")).status).toBe(false);
  });

  it("does not interpret legal comments as a lookup error", async () => {
    vi.mocked(whoisDomain).mockResolvedValue(
      response(
        "Domain Name: example.com\nRegistrar: Example Registrar\n% If a domain is not found, contact us.",
      ),
    );
    expect((await lookupWhois("example.com")).status).toBe(true);
  });
});

describe("RDAP merge and cache", () => {
  it("fills rejected RDAP dates from valid WHOIS fields without database metadata", async () => {
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
    vi.mocked(whoisDomain).mockResolvedValue(response(fixture("au")));
    const result = await lookupWhois("13cabs.com.au");
    expect(result).toMatchObject({
      status: true,
      source: "rdap",
      result: {
        creationDate: "Unknown",
        updatedDate: "2026-08-15T20:04:09.000Z",
        expirationDate: "Unknown",
      },
    });
  });

  it("does not merge an unsuccessful WHOIS response into valid RDAP data", async () => {
    vi.mocked(lookupRdap).mockResolvedValue({ ldhName: "example.com" });
    vi.mocked(whoisDomain).mockResolvedValue(
      response("No match for example.com\nUpdated Date: 2020-12-24"),
    );
    expect((await lookupWhois("example.com")).result?.updatedDate).toBe(
      "Unknown",
    );
  });

  it("uses a new cache namespace so old malformed lifecycle fields are not served", async () => {
    const result = await lookupWhoisWithCache("example.com");
    expect(result.status).toBe(true);
    expect(getJsonRedisValue).toHaveBeenCalledWith("whois:v2:example.com");
    expect(setJsonRedisValue).toHaveBeenCalledWith(
      "whois:v2:example.com",
      expect.objectContaining({ status: true }),
    );
    vi.mocked(getJsonRedisValue).mockResolvedValue(result);
    vi.clearAllMocks();
    expect(await lookupWhoisWithCache("example.com")).toMatchObject({
      cached: true,
      time: 0,
    });
    expect(whoisDomain).not.toHaveBeenCalled();
  });
});
