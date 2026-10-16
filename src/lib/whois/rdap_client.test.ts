import { describe, expect, it, vi } from "vitest";
import { convertRdapToWhoisResult } from "./rdap_client";

vi.mock("@/lib/pricing/client", () => ({
  getDomainPricing: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/moz/client", () => ({
  getMozMetrics: vi
    .fn()
    .mockResolvedValue({ domainAuthority: 0, pageAuthority: 0, spamScore: 0 }),
}));

describe("RDAP domain lifecycle events", () => {
  it("validates dates and ignores database timestamps and nested entity events", async () => {
    const data = {
      ldhName: "example.com",
      events: [
        { eventAction: "registration", eventDate: "2020-02-30T00:00:00Z" },
        {
          eventAction: "last changed",
          eventDate: "Managing Registrar 20201224",
        },
        { eventAction: "expiration", eventDate: "2027-12-24T00:00:00Z <<<" },
        {
          eventAction: "last update of RDAP database",
          eventDate: "2026-10-16T13:00:00Z",
        },
      ],
      entities: [
        {
          roles: ["registrant"],
          events: [
            { eventAction: "registration", eventDate: "2020-12-24T00:00:00Z" },
          ],
        },
      ],
    };
    const result = await convertRdapToWhoisResult(data, "example.com");
    expect(result).toMatchObject({
      creationDate: "Unknown",
      updatedDate: "Unknown",
      expirationDate: "Unknown",
      domainAge: null,
      remainingDays: null,
    });
    expect(JSON.parse(result.rawRdapContent!)).toEqual(data);
  });

  it("uses a later valid event of the same action after rejecting an invalid event", async () => {
    const result = await convertRdapToWhoisResult(
      {
        events: [
          { eventAction: "registration", eventDate: "20201224" },
          {
            eventAction: "registration",
            eventDate: "2020-12-24T08:00:00+08:00",
          },
          { eventAction: "last changed", eventDate: "2021-01-01T00:00:00Z" },
          { eventAction: "expiration", eventDate: "2027-12-24T00:00:00Z" },
        ],
      },
      "example.com",
    );
    expect(result).toMatchObject({
      creationDate: "2020-12-24T00:00:00.000Z",
      updatedDate: "2021-01-01T00:00:00.000Z",
      expirationDate: "2027-12-24T00:00:00.000Z",
    });
    expect(Number.isFinite(result.domainAge)).toBe(true);
    expect(Number.isFinite(result.remainingDays)).toBe(true);
  });
});
