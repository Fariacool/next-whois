# Batch lookups and shared scheduling

`GET /api/lookup?query=example.com` and `POST /api/lookup/batch` use the same
query service. Existing single-query response fields are preserved.

## Query strategy

1. Normalize and validate the query, then check successful-result caches and
   join an existing lookup for the same normalized query when available.
2. Query RDAP first. A usable registration record is returned directly with
   `source: "rdap"`, `rawRdapContent`, and empty `rawWhoisContent`.
3. Fall back to WHOIS when RDAP is unavailable, returns HTTP 404, returns no
   usable record, fails, or reaches its per-request timeout. Missing individual
   dates or contact fields in an otherwise usable RDAP record stay `Unknown`.
4. Upstream rate limits return a retryable error and put that hostname into a
   shared cooldown. They do not trigger additional fallback traffic.

The delegated `.ac.uk` namespace still goes directly to Jisc WHOIS. Children of
`.nhs.uk` retain their existing unsupported-namespace response. Domain, IPv4,
IPv6, ASN and CIDR queries remain supported, including domain URLs and IDNs.
Domain normalization uses the registrable domain; case variants and subdomains
join the same lookup. Each batch result retains the original input.

## Batch request

```bash
curl 'http://localhost:3000/api/lookup/batch' \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"queries":["example.com","8.8.8.8","AS13335","bad domain"]}'
```

The body must contain only a nonempty `queries` array of strings. The default
maximum is 10 entries, counting duplicates; the body limit is 64 KiB, including
for requests sent without `Content-Length`. Invalid JSON, a malformed array or
an excessive batch size rejects the entire request before querying upstreams.
An invalid query string fails only that item.

Accepted batches always return HTTP 200, even when every item fails:

```json
{
  "status": true,
  "time": 1.25,
  "results": [
    {
      "input": "example.com",
      "status": true,
      "time": 1.2,
      "cached": false,
      "source": "rdap",
      "result": { "domain": "example.com", "...": "same fields as a single lookup" }
    },
    {
      "input": "bad domain",
      "status": false,
      "time": 0,
      "cached": false,
      "error": "Provide a valid domain, IP address, ASN or CIDR.",
      "errorCode": "INVALID_QUERY"
    }
  ],
  "summary": { "total": 2, "succeeded": 1, "failed": 1 }
}
```

`results` retain input order and duplicates. `time` is in seconds. The response
is sent after every item finishes. Check each item's `status`; top-level
`status: true` means the batch request was accepted. Missing-name WHOIS replies
remain unsuccessful results, consistent with the existing single-query API.

## Limits and caching

| Environment variable | Default | Allowed range |
| --- | --- | --- |
| `WHOIS_BATCH_LIMIT` | 10 | 1–100 |
| `WHOIS_MAX_CONCURRENT` | 20 | 1–200 |
| `WHOIS_PER_SERVER_CONCURRENT` | 5 | 1–200 |

Invalid settings fall back to their defaults. Restart after changing runtime
settings; Docker Compose passes all three variables to the container.

Connection limits apply per Node.js process to actual outgoing RDAP HTTP and
WHOIS TCP requests, including IANA discovery, HTTP redirects and WHOIS
referrals. A connection permit covers response-body consumption or TCP closure.
Queues skip saturated hostnames so other upstreams can make progress.
Limits and cooldowns are shared by single queries, batches and OG requests
that call the lookup API. Multiple processes or containers have separate
limits. Domain pricing and optional Moz requests have their own five-second
timeouts and are outside the registration-connection limits.

Each registration request has a five-second deadline. A lookup has a
30-second deadline covering queueing, discovery, fallback and result enrichment;
HTTP/TCP operations receive its abort signal. Queues are bounded to 200 waiting
connections and 200 unique in-flight lookups. Upstream response bodies are
limited to 1 MiB. A slow item can delay the batch until its deadline.

Successful results are cached in memory for one hour by default (up to 2,000
normalized queries), with optional Redis persistence. `REDIS_CACHE_TTL` overrides
the successful-result TTL when positive. Errors are not cached. Joining an
in-flight query reports `cached: false`; reusing a completed cache entry reports
`cached: true` and `time: 0`. Restarting clears process memory. Redis failures
fall back to the in-process cache and live lookups. The `whois:v3:` namespace
excludes results assembled by the former parallel merger.

## Authentication and errors

When `API_KEY` is set, both endpoints require `Authorization: Bearer <key>`.
Batch authentication runs before method checks, JSON parsing or cache access.
Batch responses always use `private, no-store`; successful public single-query
responses retain their existing shared HTTP cache behavior.

Batch request errors use HTTP 400 (JSON/shape/size count), 401 (authentication),
405 (method), 413 (body bytes) or 415 (content type). Query failures may include
`errorCode`: `INVALID_QUERY`, `BUSY`, `LOOKUP_TIMEOUT`, `UPSTREAM_RATE_LIMITED`
or `LOOKUP_FAILED`. Single queries map these codes to 400, 503, 504, 429 and 500
respectively. Rate-limited or busy results include `retryAfterSeconds`; single
responses also set `Retry-After`. Individual batch failures stay in `results`.
