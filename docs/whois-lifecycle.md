# Lifecycle dates and delegated namespaces

`GET /api/lookup?query=<domain>` retains its existing Bearer authentication,
boolean `status`, HTTP status codes and result fields. A successful lookup is
HTTP 200 with `status: true`, including when the registry exposes only registrar,
status or nameserver information. Missing and rejected lifecycle values are
`"Unknown"`; the service does not invent registration dates to complete a result.

## Parsing contract

- WHOIS lifecycle fields use an exact label allowlist in
  `src/lib/whois/lifecycle_dates.ts`. Labels are case-insensitive; whitespace and
  terminal dot padding are normalized. Substring matches such as "last update
  of WHOIS database" or "registrar creation date" cannot set lifecycle fields.
- The **entire trimmed value** must match a supported format and a valid calendar
  date. ISO timestamps with explicit offsets are converted to UTC. Date-only
  values and supported legacy WHOIS times without a timezone use UTC. Explicit
  JPRS `(JST)` timestamps retain their timezone meaning. This UTC convention does
  not imply that a registry disclosed an exact time of day for date-only data.
- Supported legacy forms include `YYYYMMDD`, `DD-MM-YYYY`, `DD-MMM-YYYY`,
  `YYYY/MM/DD`, dotted dates and the full Jisc weekday/ordinal grammar. Trailing
  `<<<`, embedded labels, registrar numbers with text, impossible dates and
  incomplete dates such as `before Aug-1996` are rejected.
- JPRS's documented `[State] Connected (YYYY/MM/DD)` / `Registered (...)`
  expiry grammar is retained only for JP domains with a complete valid value;
  arbitrary dates embedded in a status field are not used. See the
  [JPRS display guide](https://jprs.jp/about/dom-search/jprs-whois/whois-guide-view.html).
- Section boundaries matter: `[Whois] Updated`, holder/registrar section dates
  and identified contact-object dates do not describe domain lifecycle events.
  Comments and WHOIS database footers cannot set domain dates. Database metadata
  stays in `rawWhoisContent` or `rawRdapContent`.
- RDAP uses only top-level `registration`, `last changed` and `expiration`
  events with valid RFC 3339 timestamps. Entity events and `last update of RDAP
  database` are not lifecycle events. A malformed event cannot prevent a later
  valid event or WHOIS fallback from supplying the date.
- Rejected dates alone do not fail a lookup when other usable data exists.
  Transport failures, authoritative missing-name replies, rate limits and empty
  responses remain unsuccessful lookups.

## Registry-specific behavior

| Namespace | Behavior |
| --- | --- |
| `.au` | `Last Modified` is the domain record update time. The database footer is ignored. Creation/expiry normally remain `Unknown`. |
| `.il` (including `.co.il` / `.org.il`) | `assigned` supplies creation and `validity` supplies expiry. The complete legacy `changed: domain-registrar AT isoc.org.il YYYYMMDD (Assigned)` grammar can supply missing creation. Other `changed` history is ignored because it mixes domain, contact and registrar changes. |
| `.pe` and its child namespaces | Only explicit lifecycle fields qualify. A database footer alone supplies no dates. Registrar/status/NS data remain usable. |
| `.lv` | `[Whois] Updated` is a database refresh. `[Registrar] Name` and nameservers remain available without lifecycle dates. |
| `.ac.uk` | Query `whois.ja.net` directly and parse its indented `Domain`, `Registered By`, `Servers`, `Entry created`, `Entry updated` and `Renewal date` fields. Ordinary `.uk` RDAP cannot supply this delegated record. |
| Children of `.nhs.uk` | Return `status: false` with `Unsupported WHOIS/RDAP namespace: NHS-managed .nhs.uk subdomains` through the existing error response. This service has no authoritative public lookup route for those NHS-managed children. Replies from Jisc or Nominet do not establish non-registration. The apex `nhs.uk` keeps its ordinary lookup path. |

The `.il`, `.pe` and `.lv` WHOIS routes use the known registry hosts from
[IANA's `.il` entry](https://www.iana.org/domains/root/db/il.html),
[`.pe` entry](https://www.iana.org/domains/root/db/pe.html) and
[`.lv` entry](https://www.iana.org/domains/root/db/lv.html). This avoids whoiser's
separate one-second IANA discovery timeout before an otherwise reachable
registry is queried. Other namespaces retain automatic discovery.

auDA explicitly withholds creation, renewal and expiry dates in
[WHOIS Policy 2025-11 §4.5](https://www.auda.org.au/au-domain-names/au-rules-and-policies/whois-policy-2025-11/).
Schedule A separately defines the public `Last Modified` field as a domain
record modification date, so it is retained when valid.

[NIC.LV WHOIS Policy §4](https://www.nic.lv/en/nic-whois-policy) lists the public
fields without lifecycle dates, and §5 describes periodic database refreshes.
That refresh is not evidence of a domain change.

[ISOC-IL's 2026 policy update](https://en.isoc.org.il/il-cctld/registry-updatesnews/whois_policy_update_2026)
retains registration and expiration dates. The minimized Peru response in the
fixtures had no lifecycle fields; this does not establish a permanent `.pe`
non-disclosure policy.

[Jisc](https://www.jisc.ac.uk/domain-registry) manages `.ac.uk`.
[NHS England](https://digital.nhs.uk/services/networking-addressing) controls
`nhs.uk`; its [DNS guidance](https://digital.nhs.uk/services/health-and-social-care-network/hscn-technical-guidance/dns)
identifies NHS organization names as subdomains of that apex. Do not route
`.nhs.uk` children to Jisc or copy a parent's dates into a child result.

## Cache rollout

Redis lookup keys use `whois:v2:<query>` so results from the former permissive
parser are not reused. Old keys are left to their existing expiry policy.
Public browser/CDN entries can still exist for their configured cache lifetime;
Bearer-protected responses continue to disable browser/CDN caching.

## Verification and optional handoff regression

Run `pnpm test` and `pnpm exec tsc --noEmit`. Registry response excerpts and their
provenance are in `src/lib/whois/fixtures/README.md`. Tests cover malformed dates,
eight-digit non-date identifiers, database metadata, partial results, Jisc
routing, RDAP merge, the versioned cache and Bearer API compatibility.

The optional report tool reads the Site Lens `next-whois-issues.json` handoff.
The 2026-10-16 snapshot has 2,743 unique domains across 12 suffixes, but its
historical statuses mix multiple providers. They are **not** a next-whois
before/after baseline and cannot establish how many next-whois errors were fixed.

Plan the full input without network requests:

```bash
node scripts/whois-regression.mjs --input /path/to/next-whois-issues.json \
  --all --output /tmp/whois-plan.json
```

Compare two deployments with one domain per suffix (the default sample size):

```bash
# Set API_KEY and BASELINE_API_KEY in the environment when required.
node scripts/whois-regression.mjs --input /path/to/next-whois-issues.json \
  --endpoint https://new-service.example \
  --baseline-endpoint https://old-service.example \
  --output /tmp/whois-comparison.json
```

Use `--per-suffix 3` or select `--suffixes ac.uk,co.il,lv`. Only `--all` opts into
all selected domains. Requests are sequential with a default five-second delay;
registry access policies and rate limits still apply. A full run is optional,
not part of the offline test suite. Authentication failures stop the run, and
completed results are saved incrementally. The report stores no keys or raw
contact data.

`found`, `partial`, `no_data`, `unsupported`, `not_registered` and `error` are
**report classifications**, not new API fields. `found` requires a valid creation
date; other useful dates/registrar data are `partial`. Invalid nonempty lifecycle
values without valid creation count as `error`, matching the relevant Site Lens
consumer behavior. Paired endpoint runs produce per-suffix transition counts,
including `error -> found/partial/no_data`. Without a baseline endpoint, only
observed statuses and provider-attributed historical counts are reported.

Optional live comparisons may hit server caches and may observe registry data
changes between requests. Keep the sample size, endpoints, time and cache flags
with any claimed before/after result.
