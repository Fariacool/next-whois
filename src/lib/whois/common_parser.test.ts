import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWhois } from "./common_parser";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const dates = (raw: string, query = "") => {
  const { creationDate, updatedDate, expirationDate } = parseWhois(raw, query);
  return { creationDate, updatedDate, expirationDate };
};
const unknown = {
  creationDate: "Unknown",
  updatedDate: "Unknown",
  expirationDate: "Unknown",
};

describe("registry lifecycle fixtures", () => {
  it("AU uses Last Modified and ignores the later database footer", () => {
    const result = parseWhois(fixture("au"));
    expect(result).toMatchObject({
      domain: "13cabs.com.au",
      registrar: "Melbourne IT",
      ...unknown,
      updatedDate: "2026-08-15T20:04:09.000Z",
    });
    expect(result.status).toHaveLength(3);
    expect(
      dates(
        fixture("au").replace(
          /^Last Modified:.*$/m,
          "Last Modified: 2026-08-15T20:04:09Z <<<",
        ),
      ),
    ).toEqual(unknown);
    expect(dates(fixture("au").replace(/^Last Modified:.*\n/m, ""))).toEqual(
      unknown,
    );
  });

  it.each(["co.il", "org.il"])(
    "IL binds assigned and validity for %s without interpreting registrar history",
    (suffix) => {
      const raw = fixture("il").replaceAll(
        "019mobile.co.il",
        `example.${suffix}`,
      );
      expect(parseWhois(raw)).toMatchObject({
        domain: `example.${suffix}`,
        registrar: "LiveDNS Ltd",
        creationDate: "2014-10-02T00:00:00.000Z",
        expirationDate: "2027-10-02T00:00:00.000Z",
        updatedDate: "Unknown",
      });
    },
  );

  it("IL supports the complete legacy assignment marker, never a registrar number", () => {
    const legacy = fixture("il").replace(/^assigned:.*\n/m, "");
    expect(dates(legacy).creationDate).toBe("2014-10-02T00:00:00.000Z");
    const raw =
      "domain: example.co.il\nchanged: Managing Registrar 20201224\nchanged: 20201224\nchanged: domain-registrar AT isoc.org.il 20201224 (Changed)";
    expect(dates(raw)).toEqual(unknown);
    expect(
      dates(
        raw + "\nassigned: Managing Registrar 20201224\nvalidity: 20201324",
      ),
    ).toEqual(unknown);
  });

  it.each(["pe", "com.pe", "edu.pe", "gob.pe", "net.pe", "org.pe"])(
    "%s preserves registrar/status without inventing a lifecycle date",
    (suffix) => {
      const raw = fixture("pe").replace("abril.pe", `example.${suffix}`);
      expect(dates(raw)).toEqual(unknown);
      expect(parseWhois(raw)).toMatchObject({
        domain: `example.${suffix}`,
        registrar: "NIC.PE",
        status: [{ status: "ok", url: "" }],
      });
    },
  );

  it("LV isolates [Whois] database updates and registrar/holder objects", () => {
    const result = parseWhois(fixture("lv"));
    expect(result).toMatchObject({
      domain: "1a.lv",
      registrar: "Interneto vizija UAB",
      ...unknown,
    });
    expect(result.nameServers).toEqual([
      "dan.ns.cloudflare.com",
      "ines.ns.cloudflare.com",
    ]);
    expect(
      dates(fixture("lv").replace("RegNr: 20201224", "Created: 20201224")),
    ).toEqual(unknown);
    expect(
      dates(
        fixture("lv")
          .replace("[Whois]", "[Registrar]")
          .replace("Updated:", "Changed:"),
      ),
    ).toEqual(unknown);
  });

  it("Jisc reads multiline dates, registrar, domain and nameservers", () => {
    const result = parseWhois(fixture("jisc"));
    expect(result).toMatchObject({
      domain: "abdn.ac.uk",
      registrar: "Jisc Services Limited",
      registrantOrganization: "University of Aberdeen",
      creationDate: "2003-09-18T00:00:00.000Z",
      updatedDate: "2025-08-23T00:00:00.000Z",
      expirationDate: "2027-11-23T00:00:00.000Z",
    });
    expect(result.nameServers).toEqual([
      "ns2.abdn.ac.uk",
      "ns3.abdn.ac.uk",
      "ns0.abdn.ac.uk",
      "ns1.abdn.ac.uk",
      "ns1.ja.net",
    ]);
    expect(
      dates(
        fixture("jisc").replace(
          "Thursday 18th September 2003",
          "Managing Registrar 20201224",
        ),
      ).creationDate,
    ).toBe("Unknown");
    expect(
      dates(
        fixture("jisc").replace(
          "Saturday 23rd August 2025",
          "Saturday 23rd August 2025 <<<",
        ),
      ).updatedDate,
    ).toBe("Unknown");
  });
});

describe("field and record boundaries", () => {
  it("does not treat date-shaped identifiers or database metadata as lifecycle fields", () => {
    const raw =
      "domain: example.com\nregistration number: 20201224\nregistrar creation date: 20201224\nlast update of WHOIS database: 2020-12-24T00:00:00Z\n>>> Last update of WHOIS database: 2020-12-24T00:00:00Z <<<\n# Updated Date: 2020-12-24T00:00:00Z\nstate: Connected (2020/12/24)";
    expect(dates(raw)).toEqual(unknown);
  });

  it("a bad date cannot erase an earlier valid date or absorb the next label", () => {
    const raw =
      "Domain Name: example.com\nCreation Date: 2020-12-24\nCreation Date: Managing Registrar 20201224\nUpdated Date:\n  Registrar: Example Registrar\n  Expiry date: 2027-12-24";
    expect(dates(raw)).toEqual({
      ...unknown,
      creationDate: "2020-12-24T00:00:00.000Z",
      expirationDate: "2027-12-24T00:00:00.000Z",
    });
  });

  it("contact timestamps cannot overwrite the domain record", () => {
    const raw =
      "domain: example.fr\ncreated: 2020-12-24\nlast-update: 2021-01-01\n\nnic-hdl: CONTACT\ncreated: 2025-01-01\nlast-update: 2025-01-02";
    expect(dates(raw)).toEqual({
      creationDate: "2020-12-24T00:00:00.000Z",
      updatedDate: "2021-01-01T00:00:00.000Z",
      expirationDate: "Unknown",
    });
  });

  it("preserves documented JPRS state expiry without using contact updates", () => {
    const raw =
      "[ JPRS database provides information on network administration. ]\nDomain Information:\na. [Domain Name] EXAMPLE.CO.JP\n[State] Connected (2027/03/31)\n[Registered Date] 2020/12/24\n[Last Update] 2021/01/01 09:00:00 (JST)\nContact Information:\na. [JPNIC Handle] TESTJP\n[Last Update] 2025/01/01 09:00:00 (JST)";
    expect(dates(raw)).toEqual({
      creationDate: "2020-12-24T00:00:00.000Z",
      expirationDate: "2027-03-31T00:00:00.000Z",
      updatedDate: "2021-01-01T00:00:00.000Z",
    });
    expect(
      dates(raw.replace("Connected (2027/03/31)", "Other state (2027/03/31)"))
        .expirationDate,
    ).toBe("Unknown");
    expect(
      dates(raw.replace("Connected (2027/03/31)", "Connected (2027/02/30)"))
        .expirationDate,
    ).toBe("Unknown");
    expect(
      dates(raw.replace("Connected (2027/03/31)", "Connected (2027/03/31) <<<"))
        .expirationDate,
    ).toBe("Unknown");
  });

  it.each([
    [
      "[Created on] 2020/12/24\n[Expires on] 2027/12/24\n[Last Updated] 2021/01/01 09:00:00 (JST)",
      "2020-12-24T00:00:00.000Z",
      "2027-12-24T00:00:00.000Z",
    ],
    [
      "created: 20201224\nexpires: 20271224\nchanged: 20210101",
      "2020-12-24T00:00:00.000Z",
      "2027-12-24T00:00:00.000Z",
    ],
    [
      "Registered on: 24-Dec-2020\nExpiry date: 24-Dec-2027\nLast updated: 01-Jan-2021",
      "2020-12-24T00:00:00.000Z",
      "2027-12-24T00:00:00.000Z",
    ],
  ])(
    "preserves established lifecycle aliases and formats",
    (raw, creationDate, expirationDate) => {
      expect(dates(raw)).toEqual({
        creationDate,
        expirationDate,
        updatedDate: "2021-01-01T00:00:00.000Z",
      });
    },
  );
});
