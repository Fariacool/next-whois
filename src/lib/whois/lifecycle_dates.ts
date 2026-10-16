import moment from "moment";

// Match the whole value before parsing. Date.parse and non-strict parsers accept
// labels, numeric identifiers, trailing text and even impossible calendar dates.
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

const WHOIS_FORMATS: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"],
  [/^\d{4}\/\d{2}\/\d{2}$/, "YYYY/MM/DD"],
  [/^\d{8}$/, "YYYYMMDD"],
  [/^\d{2}-\d{2}-\d{4}$/, "DD-MM-YYYY"],
  [/^\d{2}-[A-Za-z]{3}-\d{4}$/, "DD-MMM-YYYY"],
  [/^\d{4}-[A-Za-z]{3}-\d{2}$/, "YYYY-MMM-DD"],
  [/^\d{4}\.\d{2}\.\d{2}$/, "YYYY.MM.DD"],
  [/^\d{4}\. \d{2}\. \d{2}\.$/, "YYYY. MM. DD."],
  [/^\d{2}\.\d{2}\.\d{4}$/, "DD.MM.YYYY"],
  [/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "YYYY-MM-DD HH:mm:ss"],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "YYYY-MM-DD[T]HH:mm:ss"],
  [/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/, "YYYY.MM.DD HH:mm:ss"],
  [/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/, "DD.MM.YYYY HH:mm:ss"],
  [
    /^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} UTC$/,
    "DD-MMM-YYYY HH:mm:ss [UTC]",
  ],
  [/^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/, "DD-MMM-YYYY HH:mm:ss"],
  [/^[A-Za-z]{3} \d{1,2} \d{4}$/, "MMM D YYYY"],
  [
    /^[A-Za-z]{3} [A-Za-z]{3} \d{2} \d{2}:\d{2}:\d{2} \d{4}$/,
    "ddd MMM DD HH:mm:ss YYYY",
  ],
];

export function parseRdapDate(value: unknown): string | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value.trim())) return null;
  const parsed = moment.parseZone(
    value.trim().toUpperCase(),
    moment.ISO_8601,
    true,
  );
  return parsed.isValid() ? parsed.toISOString() : null;
}

export function parseWhoisDate(value: string): string | null {
  const date = value.trim();
  const timestamp = parseRdapDate(date);
  if (timestamp) return timestamp;

  // Jisc publishes e.g. "Thursday 18th September 2003". Accept only that
  // complete grammar, including a valid weekday and ordinal suffix.
  const jisc = date.match(
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2})(st|nd|rd|th) ([A-Za-z]+) (\d{4})$/,
  );
  if (jisc) {
    const [, weekday, day, ordinal, month, year] = jisc;
    const parsed = moment.utc(
      `${weekday} ${Number(day)} ${month} ${year}`,
      `dddd D ${month.length === 3 ? "MMM" : "MMMM"} YYYY`,
      "en",
      true,
    );
    return parsed.isValid() &&
      parsed.format("Do") === `${Number(day)}${ordinal}`
      ? parsed.toISOString()
      : null;
  }

  // JPRS uses an explicit Japan Standard Time annotation.
  if (
    /^\d{4}\/\d{2}\/\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \(JST\)$/.test(date)
  ) {
    const parsed = moment.utc(date, "YYYY/MM/DD HH:mm:ss [(JST)]", "en", true);
    return parsed.isValid() ? parsed.subtract(9, "hours").toISOString() : null;
  }

  for (const [pattern, format] of WHOIS_FORMATS) {
    if (!pattern.test(date)) continue;
    const parsed = moment.utc(date, format, "en", true);
    // Moment accepts 24:00:00 as the next day; WHOIS times must be within a day.
    if (parsed.isValid() && !/[T ]24:/.test(date)) return parsed.toISOString();
  }
  return null;
}

export type LifecycleField = "creationDate" | "updatedDate" | "expirationDate";

const DATE_FIELDS: Record<string, LifecycleField> = {
  "creation date": "creationDate",
  "created date": "creationDate",
  created: "creationDate",
  "created on": "creationDate",
  "registered date": "creationDate",
  "registration date": "creationDate",
  "registration time": "creationDate",
  registered: "creationDate",
  "registered on": "creationDate",
  "domain registered": "creationDate",
  "domain name commencement date": "creationDate",
  "record created": "creationDate",
  "entry created": "creationDate",
  "updated date": "updatedDate",
  "last updated date": "updatedDate",
  "last updated": "updatedDate",
  "last updated on": "updatedDate",
  "last update": "updatedDate",
  "last-update": "updatedDate",
  "last-modified": "updatedDate",
  "last modified": "updatedDate",
  "last modified date": "updatedDate",
  "modification date": "updatedDate",
  updated: "updatedDate",
  modified: "updatedDate",
  changed: "updatedDate",
  "record last updated on": "updatedDate",
  "entry updated": "updatedDate",
  "expiration date": "expirationDate",
  "expiration time": "expirationDate",
  "registrar registration expiration date": "expirationDate",
  "registry expiry date": "expirationDate",
  "registry expiration date": "expirationDate",
  "expiry date": "expirationDate",
  "expire date": "expirationDate",
  "expires on": "expirationDate",
  expires: "expirationDate",
  expiry: "expirationDate",
  expire: "expirationDate",
  "paid-till": "expirationDate",
  "valid until": "expirationDate",
  "renewal date": "expirationDate",
  "record expires on": "expirationDate",
};

export function lifecycleField(key: string): LifecycleField | undefined {
  return Object.hasOwn(DATE_FIELDS, key) ? DATE_FIELDS[key] : undefined;
}
