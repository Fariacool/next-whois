import { describe, expect, it } from "vitest";
import {
  lifecycleField,
  parseRdapDate,
  parseWhoisDate,
} from "./lifecycle_dates";

describe("strict lifecycle dates", () => {
  it.each([
    ["2026-10-16T13:11:42Z", "2026-10-16T13:11:42.000Z"],
    ["2026-10-16t13:11:42z", "2026-10-16T13:11:42.000Z"],
    ["2026-10-16T11:12:38.391868+00:00", "2026-10-16T11:12:38.391Z"],
    ["2026-10-16T13:11:42+08:00", "2026-10-16T05:11:42.000Z"],
    ["2020-02-29", "2020-02-29T00:00:00.000Z"],
    ["20201224", "2020-12-24T00:00:00.000Z"],
    ["02-10-2014", "2014-10-02T00:00:00.000Z"],
    ["15-Sep-1997", "1997-09-15T00:00:00.000Z"],
    ["2020-Oct-16", "2020-10-16T00:00:00.000Z"],
    ["2020/10/16", "2020-10-16T00:00:00.000Z"],
    ["2020.10.16 13:11:42", "2020-10-16T13:11:42.000Z"],
    ["16.10.2020 13:11:42", "2020-10-16T13:11:42.000Z"],
    ["2020. 10. 16.", "2020-10-16T00:00:00.000Z"],
    ["16-Oct-2020 13:11:42 UTC", "2020-10-16T13:11:42.000Z"],
    ["2020/10/16 13:11:42 (JST)", "2020-10-16T04:11:42.000Z"],
    ["Thursday 18th September 2003", "2003-09-18T00:00:00.000Z"],
    ["Tuesday 23rd Nov 2027", "2027-11-23T00:00:00.000Z"],
    ["Fri Oct 16 13:11:42 2020", "2020-10-16T13:11:42.000Z"],
  ])("normalizes the entire supported value %s", (value, expected) => {
    expect(parseWhoisDate(value)).toBe(expected);
  });

  it.each([
    "",
    "Unknown",
    "2020",
    "1",
    "20200230",
    "2020-02-30",
    "2019-02-29",
    "2020-13-01",
    "2020-10-16T24:00:00Z",
    "2020-10-16 24:00:00",
    "2020/10/16 24:00:00 (JST)",
    "2020-10-16T13:11:42+99:00",
    "2020-10-16T13:11:42+08:99",
    "2026-10-16T13:11:42Z <<<",
    "<2026-10-16T13:11:42Z>",
    "Updated Date: 2020-12-24",
    "Managing Registrar 20201224",
    "domain-registrar AT isoc.org.il 20201224",
    "20201224 (Assigned)",
    "before Aug-1996",
    "Thursday 18st September 2003",
    "Friday 18th September 2003",
  ])(
    "rejects labels, identifiers, trailing text and invalid dates: %s",
    (value) => {
      expect(parseWhoisDate(value)).toBeNull();
    },
  );

  it("requires RDAP timestamps rather than accepting WHOIS-only formats", () => {
    expect(parseRdapDate("2026-10-16T13:11:42.5Z")).toBe(
      "2026-10-16T13:11:42.500Z",
    );
    for (const value of [
      "20201224",
      "2020-12-24",
      "2020-02-30T00:00:00Z",
      "2020-12-24T00:00:00Z <<<",
      null,
      20201224,
    ]) {
      expect(parseRdapDate(value)).toBeNull();
    }
  });

  it("recognizes only exact domain lifecycle labels", () => {
    expect(lifecycleField("last modified")).toBe("updatedDate");
    for (const label of [
      "last update of whois database",
      ">>> last update of whois database",
      "whois updated",
      "registration number",
      "registrar creation date",
      "constructor",
      "toString",
    ]) {
      expect(lifecycleField(label)).toBeUndefined();
    }
  });
});
