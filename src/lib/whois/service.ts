import { getJsonRedisValue, setJsonRedisValue } from "@/lib/server/redis";
import {
  CACHE_TTL_MS,
  LOOKUP_TIMEOUT_MS,
  MAX_CACHED_LOOKUPS,
  MAX_PENDING_LOOKUPS,
} from "./config";
import { LookupError, upstreamError } from "./errors";
import { normalizeQuery } from "./query";
import { WhoisBatchResult, WhoisResult } from "./types";

type Entry = { result: WhoisResult; expiresAt: number };
type Lookup = (query: string, signal: AbortSignal) => Promise<WhoisResult>;

export class WhoisLookupService {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<WhoisResult>>();

  constructor(
    private readonly provider: Lookup,
    private readonly now = Date.now,
    private readonly ttl = CACHE_TTL_MS,
  ) {}

  async lookup(input: string): Promise<WhoisResult> {
    const started = this.now();
    try {
      const query = normalizeQuery(input).value;
      const cached = this.entries.get(query);
      if (cached && cached.expiresAt > this.now())
        return { ...cached.result, cached: true, time: 0 };
      this.entries.delete(query);
      let pending = this.inflight.get(query);
      if (!pending) {
        if (this.inflight.size >= MAX_PENDING_LOOKUPS)
          throw new LookupError(
            "BUSY",
            "The lookup queue is full. Retry later.",
            1,
          );
        pending = this.load(query).finally(() => this.inflight.delete(query));
        this.inflight.set(query, pending);
      }
      return { ...(await pending) };
    } catch (error) {
      const failure = upstreamError(error, new AbortController().signal);
      return {
        status: false,
        time: Math.max(0, this.now() - started) / 1_000,
        cached: false,
        error: failure.message,
        errorCode: failure.code,
        ...(failure.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: failure.retryAfterSeconds }
          : {}),
      };
    }
  }

  private remember(query: string, entry: Entry) {
    if (this.entries.size >= MAX_CACHED_LOOKUPS)
      this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(query, entry);
  }

  private async load(query: string): Promise<WhoisResult> {
    // A new namespace excludes responses assembled by the old parallel merger.
    const key = `whois:v3:${query}`;
    let cached: Entry | null = null;
    try {
      cached = await getJsonRedisValue<Entry>(key);
    } catch {
      /* Cache outages do not block live lookups. */
    }
    if (cached?.result?.status && cached.expiresAt > this.now()) {
      this.remember(query, cached);
      return { ...cached.result, time: 0, cached: true };
    }
    const result = {
      ...(await this.provider(query, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))),
      cached: false,
    };
    if (result.status) {
      const configuredTtl = Number(process.env.REDIS_CACHE_TTL);
      const ttl =
        Number.isSafeInteger(configuredTtl) && configuredTtl > 0
          ? configuredTtl * 1_000
          : this.ttl;
      const entry = { result, expiresAt: this.now() + ttl };
      this.remember(query, entry);
      try {
        await setJsonRedisValue(key, entry);
      } catch {
        /* Keep the in-process result. */
      }
    }
    return result;
  }

  async batch(inputs: string[]): Promise<WhoisBatchResult> {
    const started = this.now();
    const results = await Promise.all(
      inputs.map(async (input) => ({ input, ...(await this.lookup(input)) })),
    );
    const succeeded = results.filter((result) => result.status).length;
    return {
      status: true,
      time: Math.max(0, this.now() - started) / 1_000,
      results,
      summary: {
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
      },
    };
  }
}
