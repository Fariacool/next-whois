import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestRdap, rdapServer } from "./rdap_lookup";

const { json } = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("./transport", () => ({ registrationTransport: () => ({ json }) }));
beforeEach(() => {
  vi.clearAllMocks();
  delete (
    globalThis as typeof globalThis & { nextWhoisRdapDiscovery?: unknown }
  ).nextWhoisRdapDiscovery;
});

describe("RDAP discovery and record validation", () => {
  it("shares bootstrap discovery across concurrent domains and preserves the final endpoint", async () => {
    json.mockImplementation(async (value: string | URL) => {
      const url = new URL(value);
      const data =
        url.hostname === "data.iana.org"
          ? { services: [[["com"], ["https://rdap.example/"]]] }
          : {
              objectClassName: "domain",
              ldhName: url.pathname.split("/").pop(),
            };
      return { status: 200, data, server: url.href };
    });
    const [a, b] = await Promise.all([
      requestRdap("a.com"),
      requestRdap("b.com"),
    ]);
    expect(
      json.mock.calls.filter(([url]) => String(url).includes("data.iana.org")),
    ).toHaveLength(1);
    expect(a).toMatchObject({ ldhName: "a.com" });
    expect(b).toMatchObject({ ldhName: "b.com" });
    expect(rdapServer(a as object)).toBe("https://rdap.example/domain/a.com");
    expect(JSON.stringify(a)).not.toContain("rdap.example");
  });

  it.each([
    [
      "8.8.8.8/24",
      "ipv4",
      "0.0.0.0/0",
      {
        objectClassName: "ip network",
        startAddress: "8.8.8.0",
        endAddress: "8.8.8.255",
      },
      "/ip/8.8.8.8/24",
    ],
    [
      "2001:db8::1",
      "ipv6",
      "2001:db8::/32",
      {
        objectClassName: "ip network",
        startAddress: "2001:db8::",
        endAddress: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      },
      "/ip/2001:db8::1",
    ],
    [
      "AS13335",
      "asn",
      "10000-20000",
      { objectClassName: "autnum", startAutnum: 13335, endAutnum: 13335 },
      "/autnum/13335",
    ],
  ])(
    "routes %s through its IANA bootstrap",
    async (input, kind, range, data, path) => {
      json.mockImplementation(async (value: string | URL) => {
        const url = new URL(value);
        if (url.hostname === "data.iana.org") {
          expect(url.pathname).toBe(`/rdap/${kind}.json`);
          return {
            status: 200,
            data: { services: [[[range], ["https://rdap.example/"]]] },
            server: url.href,
          };
        }
        expect(url.pathname).toBe(path);
        return { status: 200, data: { ...data }, server: url.href };
      });
      expect(await requestRdap(input)).toEqual(data);
    },
  );

  it("treats HTTP 404 as no result and rejects records for another domain", async () => {
    json
      .mockResolvedValueOnce({
        status: 200,
        data: { services: [[["com"], ["https://rdap.example/"]]] },
      })
      .mockResolvedValueOnce({ status: 404, data: null });
    expect(await requestRdap("a.com")).toBeNull();
    json.mockResolvedValueOnce({ status: 200, data: { ldhName: "wrong.com" } });
    await expect(requestRdap("a.com")).rejects.toMatchObject({
      code: "LOOKUP_FAILED",
    });
  });
});
