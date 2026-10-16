import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const EMPTY = /^(?:unknown|n\/a|na|none|null|-)?$/i;
const DATE_FIELDS = ["creationDate", "expirationDate", "updatedDate"];
const present = (value) =>
  typeof value === "string" && !EMPTY.test(value.trim());

export function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i,
  );
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= days[m - 1] &&
    Number.isFinite(Date.parse(value))
  );
}

// Report-only labels follow Site Lens's core distinction: a valid creation date
// is found, other useful lifecycle/registrar information is partial. They do not
// change next-whois's boolean status API or claim domain availability from DNS.
export function classifyResponse(payload, domain, now = Date.now()) {
  if (payload?.status === false) {
    const error = String(payload.error || "");
    if (
      /unsupported|not supported|not available for (?:this )?TLD/i.test(error)
    )
      return { status: "unsupported", invalidDates: [] };
    if (/no match for|no entries found/i.test(error))
      return { status: "not_registered", invalidDates: [] };
    if (/no[_ ]data|empty/i.test(error))
      return { status: "no_data", invalidDates: [] };
    return { status: "error", invalidDates: [] };
  }
  const result = payload?.result;
  if (
    payload?.status !== true ||
    result?.domain?.toLowerCase() !== domain.toLowerCase()
  )
    return { status: "error", invalidDates: [] };
  const valid = (field) =>
    validTimestamp(result[field]) &&
    (field === "expirationDate" || Date.parse(result[field]) <= now);
  const invalidDates = DATE_FIELDS.filter(
    (field) => present(result[field]) && !valid(field),
  );
  if (!valid("creationDate") && invalidDates.length)
    return { status: "error", invalidDates };
  const status = valid("creationDate")
    ? "found"
    : DATE_FIELDS.some(valid) ||
        present(result.registrar) ||
        present(result.ianaId)
      ? "partial"
      : "no_data";
  return { status, invalidDates };
}

export function snapshotRows(snapshot) {
  const rows = new Map();
  for (const group of snapshot.issueGroups || []) {
    for (const suffix of group.suffixes || []) {
      for (const entry of suffix.domains || []) {
        const domain = entry.domain?.trim().toLowerCase();
        if (
          !domain ||
          !(domain === suffix.suffix || domain.endsWith(`.${suffix.suffix}`))
        )
          throw new Error("Snapshot domain/suffix mismatch");
        if (!rows.has(domain))
          rows.set(domain, { ...entry, domain, suffix: suffix.suffix });
      }
    }
  }
  if (!rows.size) throw new Error("Snapshot contains no domains");
  return Array.from(rows.values());
}

const increment = (object, key) => {
  object[key] = (object[key] || 0) + 1;
};

function summarize(rows, results, comparable) {
  const bySuffix = {};
  for (const row of rows) {
    const summary = (bySuffix[row.suffix] ||= {
      domains: 0,
      historicalByProvider: {},
      observed: {},
      transitions: {},
      baselineErrorTo: {},
      invalidDateResponses: 0,
    });
    summary.domains++;
    increment(
      summary.historicalByProvider,
      `${row.lookupProvider || "unknown"}:${row.lookupStatus || "unknown"}`,
    );
  }
  for (const row of results) {
    const summary = bySuffix[row.suffix];
    increment(summary.observed, row.after.status);
    if (row.after.invalidDates.length) summary.invalidDateResponses++;
    if (comparable && row.before) {
      increment(
        summary.transitions,
        `${row.before.status}->${row.after.status}`,
      );
      if (row.before.status === "error")
        increment(summary.baselineErrorTo, row.after.status);
    }
  }
  return bySuffix;
}

function endpointUrl(base, domain) {
  const url = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    throw new Error(
      "Use HTTPS or loopback HTTP; endpoint must not contain credentials, query or fragment",
    );
  if (!url.pathname.endsWith("/api/lookup"))
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/lookup`;
  url.searchParams.set("query", domain);
  return url;
}

async function request(base, domain, key, timeout) {
  try {
    const res = await fetch(endpointUrl(base, domain), {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 401 || res.status === 403) throw new Error("AUTH_STOP");
    const payload = await res.json();
    const classified = classifyResponse(payload, domain);
    return {
      ...classified,
      httpStatus: res.status,
      cached: Boolean(payload.cached),
    };
  } catch (error) {
    if (error.message === "AUTH_STOP")
      throw new Error(
        "Authentication failed; stopped before querying remaining domains",
      );
    return {
      status: "error",
      invalidDates: [],
      transportError: error.name || "RequestError",
    };
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      endpoint: { type: "string" },
      "baseline-endpoint": { type: "string" },
      "api-key-env": { type: "string", default: "API_KEY" },
      "baseline-api-key-env": { type: "string", default: "BASELINE_API_KEY" },
      "per-suffix": { type: "string", default: "1" },
      suffixes: { type: "string" },
      "delay-ms": { type: "string", default: "5000" },
      "timeout-ms": { type: "string", default: "45000" },
      all: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/whois-regression.mjs --input snapshot.json [--output report.json] [--endpoint https://new-service --baseline-endpoint https://old-service] [--all | --per-suffix 1] [--suffixes ac.uk,lv] [--delay-ms 5000]\nWithout --endpoint: plan only; no network requests. Keys: API_KEY and BASELINE_API_KEY environment variables. Live runs default to one domain per suffix; --all opts into the full list.",
    );
    return;
  }
  if (!values.input) throw new Error("--input is required");
  const number = (key, min) => {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < min)
      throw new Error(`Invalid --${key}`);
    return value;
  };
  const perSuffix = number("per-suffix", 1),
    delayMs = number("delay-ms", 0),
    timeout = number("timeout-ms", 1);
  if (values["baseline-endpoint"] && !values.endpoint)
    throw new Error("--baseline-endpoint requires --endpoint");
  if (values.endpoint) endpointUrl(values.endpoint, "example.com");
  if (values["baseline-endpoint"])
    endpointUrl(values["baseline-endpoint"], "example.com");
  const snapshot = JSON.parse(await readFile(values.input, "utf8"));
  const allRows = snapshotRows(snapshot);
  const suffixes = values.suffixes?.split(",").map((suffix) => suffix.trim());
  const rows = allRows.filter(
    (row) => !suffixes || suffixes.includes(row.suffix),
  );
  if (!rows.length) throw new Error("No domains match selected suffixes");
  const selectedCounts = {},
    selected = rows.filter((row) => {
      increment(selectedCounts, row.suffix);
      return values.all || selectedCounts[row.suffix] <= perSuffix;
    });
  const report = {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: snapshot.generatedAt,
    mode: values.endpoint ? "live" : "plan",
    snapshotDomainCount: allRows.length,
    selectedDomainCount: selected.length,
    comparison: values["baseline-endpoint"] ? "paired-endpoints" : "none",
    endpoint: values.endpoint,
    baselineEndpoint: values["baseline-endpoint"],
    note: "Historical states mix providers and are not a next-whois before/after baseline. found/partial/no_data are report classifications, not API fields. Public-policy and rate limits still apply to optional live runs.",
    bySuffix: {},
    results: [],
  };
  const save = async () => {
    report.bySuffix = summarize(
      rows,
      report.results,
      Boolean(values["baseline-endpoint"]),
    );
    if (values.output) {
      await mkdir(dirname(resolve(values.output)), { recursive: true });
      await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
    }
  };
  await save();
  if (values.endpoint) {
    for (const [index, row] of selected.entries()) {
      if (index) await delay(delayMs);
      const before = values["baseline-endpoint"]
        ? await request(
            values["baseline-endpoint"],
            row.domain,
            process.env[values["baseline-api-key-env"]],
            timeout,
          )
        : undefined;
      if (before) await delay(delayMs);
      const after = await request(
        values.endpoint,
        row.domain,
        process.env[values["api-key-env"]],
        timeout,
      );
      report.results.push({
        domain: row.domain,
        suffix: row.suffix,
        before,
        after,
      });
      await save();
      console.error(
        `${index + 1}/${selected.length} ${row.suffix}: ${before ? `${before.status}->` : ""}${after.status}`,
      );
    }
  }
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
