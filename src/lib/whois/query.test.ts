import { describe, expect, it } from "vitest";
import { matchesCidr, normalizeQuery } from "./query";
import { whoisConfig } from "./config";

describe("lookup input normalization", () => {
  it.each([
    [" Example.COM. ", "example.com"],
    ["https://www.example.com/path", "example.com"],
    ["www.example.co.uk", "example.co.uk"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["https://www.abdn.ac.uk/research", "abdn.ac.uk"],
    ["digital.nhs.uk", "digital.nhs.uk"],
    ["8.8.8.8", "8.8.8.8"],
    ["192.0.2.0/24", "192.0.2.0/24"],
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::/32", "2001:db8::/32"],
    ["as001335", "AS1335"],
    ["13335", "AS13335"],
    ["https://8.8.8.8/path", "8.8.8.8"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeQuery(input).value).toBe(expected);
  });

  it.each([
    "",
    "bad domain",
    "example.com\r\nOTHER",
    "999.8.8.8",
    "8.8.8.8/33",
    "::1/129",
    "fe80::1%lo0",
    "AS4294967296",
    "localhost",
    "a.com:43",
    "https://user:pass@example.com",
    "8.8.8.8/1/2",
  ])("rejects %j locally", (input) => {
    expect(() => normalizeQuery(input)).toThrow(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });

  it.each([
    ["192.0.2.1", "192.0.2.0/24", true],
    ["192.0.3.1", "192.0.2.0/24", false],
    ["2001:db8::1", "2001:db8::/32", true],
    ["2001:db9::1", "2001:db8::/32", false],
    ["::ffff:192.0.2.1", "::ffff:c000:200/120", true],
    ["::1", "0.0.0.0/0", false],
  ])("routes %s against %s", (ip, cidr, expected) => {
    expect(matchesCidr(ip, cidr)).toBe(expected);
  });

  it("validates runtime limits and falls back for invalid values", () => {
    expect(whoisConfig({})).toEqual({
      batchLimit: 10,
      maxConcurrent: 20,
      perServerConcurrent: 5,
    });
    expect(
      whoisConfig({
        WHOIS_BATCH_LIMIT: " 4 ",
        WHOIS_MAX_CONCURRENT: "40",
        WHOIS_PER_SERVER_CONCURRENT: "8",
      }),
    ).toEqual({ batchLimit: 4, maxConcurrent: 40, perServerConcurrent: 8 });
    for (const value of ["0", "201", "1x", "1.5", "-2", "Infinity"])
      expect(whoisConfig({ WHOIS_MAX_CONCURRENT: value }).maxConcurrent).toBe(
        20,
      );
  });
});
