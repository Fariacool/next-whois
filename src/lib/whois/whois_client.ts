import { whoisDomain } from "whoiser";
import { MAX_WHOIS_FOLLOW } from "@/lib/env";
import {
  DISCOVERY_TTL_MS,
  MAX_CACHED_LOOKUPS,
  UPSTREAM_TIMEOUT_MS,
} from "./config";
import { isJiscDomain, knownRegistryHost } from "./domain_routes";
import { isTerminalError, LookupError } from "./errors";
import { LookupQuery } from "./query";
import { registrationTransport } from "./transport";

export type WhoisRawResult = { raw: string; server: string };
type DiscoveryState = {
  entries: Map<string, { host: string; expires: number }>;
  pending: Map<string, Promise<string>>;
};
const processState = globalThis as typeof globalThis & {
  nextWhoisServerDiscovery?: DiscoveryState;
};

async function discover(query: LookupQuery, signal: AbortSignal) {
  const state = (processState.nextWhoisServerDiscovery ??= {
    entries: new Map(),
    pending: new Map(),
  });
  const value =
    query.kind === "domain"
      ? query.value.split(".").pop()!
      : query.kind === "ip"
        ? query.address
        : String(query.number);
  const key = `${query.kind}:${value}`;
  const cached = state.entries.get(key);
  if (cached && cached.expires > Date.now()) return cached.host;
  let pending = state.pending.get(key);
  if (!pending) {
    pending = registrationTransport()
      .whois("whois.iana.org", value, signal)
      .then((raw) => {
        if (
          query.kind === "domain" &&
          raw.match(/^domain:[ \t]*(\S+)[ \t]*$/im)?.[1].toLowerCase() !== value
        ) {
          throw new LookupError(
            "LOOKUP_FAILED",
            "WHOIS server discovery failed.",
          );
        }
        const host = raw
          .match(/^whois:[ \t]*(\S+)[ \t]*$/im)?.[1]
          .toLowerCase();
        if (!host)
          throw new LookupError(
            "LOOKUP_FAILED",
            "No WHOIS/RDAP server available for this query.",
          );
        if (state.entries.size >= MAX_CACHED_LOOKUPS)
          state.entries.delete(state.entries.keys().next().value!);
        state.entries.set(key, {
          host,
          expires: Date.now() + DISCOVERY_TTL_MS,
        });
        return host;
      })
      .finally(() => state.pending.delete(key));
    state.pending.set(key, pending);
  }
  const host = await pending;
  signal.throwIfAborted();
  return host;
}

export async function lookupRawWhois(
  query: LookupQuery,
  signal: AbortSignal,
): Promise<WhoisRawResult> {
  const transport = registrationTransport();
  if (query.kind === "domain" && isJiscDomain(query.value)) {
    return {
      raw: await transport.whois("whois.ja.net", query.value, signal),
      server: "whois.ja.net",
    };
  }
  const host =
    (query.kind === "domain" && knownRegistryHost(query.value)) ||
    (await discover(query, signal));
  if (query.kind !== "domain") {
    let value = query.kind === "ip" ? query.address : String(query.number);
    if (host === "whois.arin.net")
      value = query.kind === "ip" ? `+ n ${value}` : `+ a ${value}`;
    return { raw: await transport.whois(host, value, signal), server: host };
  }

  const errors: unknown[] = [];
  const data = await whoisDomain(query.value, {
    host,
    raw: true,
    follow: Math.min(Math.max(MAX_WHOIS_FOLLOW, 1), 2) as 1 | 2,
    timeout: UPSTREAM_TIMEOUT_MS,
    whoisQuery: async (server, value) => {
      try {
        return await transport.whois(server, value, signal);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  });
  const parts: string[] = [];
  let lastServer = host;
  for (const [server, entry] of Object.entries(data)) {
    if (typeof entry.__raw === "string" && entry.__raw.trim()) {
      parts.push(entry.__raw);
      lastServer = server;
    }
  }
  if (!parts.length)
    throw (
      errors.find(isTerminalError) ??
      errors[0] ??
      new LookupError("LOOKUP_FAILED", "No WHOIS server responded.")
    );
  signal.throwIfAborted();
  return { raw: parts.join("\n\n"), server: lastServer };
}
