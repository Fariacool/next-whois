import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { DISCOVERY_TTL_MS, LOOKUP_TIMEOUT_MS } from "./config";
import { isTerminalError, LookupError } from "./errors";
import { ipNumber, LookupQuery, matchesCidr, normalizeQuery } from "./query";
import { registrationTransport } from "./transport";

type Bootstrap = { services: [string[], string[]][] };
type Entry = { data: Bootstrap; expires: number };
type DiscoveryState = {
  entries: Map<string, Entry>;
  pending: Map<string, Promise<Bootstrap>>;
};
const processState = globalThis as typeof globalThis & {
  nextWhoisRdapDiscovery?: DiscoveryState;
};
const RDAP_SERVER = Symbol.for("next-whois.rdap-server");

function discovery() {
  return (processState.nextWhoisRdapDiscovery ??= {
    entries: new Map(),
    pending: new Map(),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Missing optional dates or contacts do not make a registration record unusable.
export function isRdapRecord(value: unknown, query: LookupQuery): boolean {
  if (!record(value) || value.errorCode) return false;
  const expected =
    query.kind === "domain"
      ? "domain"
      : query.kind === "ip"
        ? "ip network"
        : "autnum";
  if (value.objectClassName && value.objectClassName !== expected) return false;
  if (query.kind === "domain") {
    const name = value.ldhName || value.unicodeName;
    return (
      typeof name === "string" &&
      domainToASCII(name.replace(/\.$/, "")).toLowerCase() === query.value
    );
  }
  if (query.kind === "ip") {
    const { startAddress, endAddress } = value;
    return (
      typeof startAddress === "string" &&
      typeof endAddress === "string" &&
      isIP(startAddress) === query.version &&
      isIP(endAddress) === query.version &&
      ipNumber(startAddress) <= ipNumber(query.address) &&
      ipNumber(endAddress) >= ipNumber(query.address)
    );
  }
  const start = value.startAutnum;
  const end = value.endAutnum ?? start;
  return (
    typeof start === "number" &&
    Number.isSafeInteger(start) &&
    typeof end === "number" &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end <= 4_294_967_295 &&
    start <= query.number &&
    end >= query.number
  );
}

async function bootstrap(
  kind: string,
  signal: AbortSignal,
): Promise<Bootstrap> {
  const state = discovery();
  const entry = state.entries.get(kind);
  if (entry && entry.expires > Date.now()) return entry.data;
  let pending = state.pending.get(kind);
  if (!pending) {
    pending = registrationTransport()
      .json(`https://data.iana.org/rdap/${kind}.json`, signal)
      .then((response) => {
        const data = response.data;
        if (
          response.status !== 200 ||
          !record(data) ||
          !Array.isArray(data.services) ||
          !data.services.every(
            (service) =>
              Array.isArray(service) &&
              service.length === 2 &&
              service.every(
                (list) =>
                  Array.isArray(list) &&
                  list.every((value) => typeof value === "string"),
              ),
          )
        ) {
          throw new LookupError(
            "LOOKUP_FAILED",
            "RDAP server discovery failed.",
          );
        }
        const result = data as Bootstrap;
        state.entries.set(kind, {
          data: result,
          expires: Date.now() + DISCOVERY_TTL_MS,
        });
        return result;
      })
      .finally(() => state.pending.delete(kind));
    state.pending.set(kind, pending);
  }
  const data = await pending;
  signal.throwIfAborted();
  return data;
}

async function servers(query: LookupQuery, signal: AbortSignal) {
  const kind =
    query.kind === "domain"
      ? "dns"
      : query.kind === "asn"
        ? "asn"
        : query.version === 4
          ? "ipv4"
          : "ipv6";
  const { services } = await bootstrap(kind, signal);
  if (query.kind === "domain") {
    const tld = query.value.split(".").pop()!;
    return services.find(([tlds]) => tlds.includes(tld))?.[1] ?? [];
  }
  if (query.kind === "asn") {
    return (
      services.find(([ranges]) =>
        ranges.some((range) => {
          if (!/^\d+(?:-\d+)?$/.test(range)) return false;
          const [start, end = start] = range.split("-").map(Number);
          return start <= query.number && end >= query.number;
        }),
      )?.[1] ?? []
    );
  }
  // Longest prefix wins when bootstrap ranges overlap.
  const matching = services.flatMap(([networks, urls]) =>
    networks
      .filter((network) => matchesCidr(query.address, network))
      .map((network) => ({ prefix: Number(network.split("/")[1]), urls })),
  );
  matching.sort((a, b) => b.prefix - a.prefix);
  return matching[0]?.urls ?? [];
}

export async function requestRdap(
  input: string,
  signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
): Promise<unknown> {
  const query = normalizeQuery(input);
  const urls = await servers(query, signal);
  let lastError: unknown;
  for (const base of urls) {
    try {
      const url = new URL(base);
      const path =
        query.kind === "domain"
          ? `domain/${query.value}`
          : query.kind === "asn"
            ? `autnum/${query.number}`
            : `ip/${query.value}`;
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
      url.search = "";
      url.hash = "";
      const response = await registrationTransport().json(url, signal);
      if (response.status === 404) return null;
      if (response.status !== 200)
        throw new LookupError(
          "LOOKUP_FAILED",
          `RDAP returned HTTP ${response.status}.`,
        );
      if (!isRdapRecord(response.data, query))
        throw new LookupError(
          "LOOKUP_FAILED",
          "RDAP returned no usable registration record.",
        );
      Object.defineProperty(response.data, RDAP_SERVER, {
        value: response.server,
      });
      return response.data;
    } catch (error) {
      if (isTerminalError(error) || signal.aborted) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export function rdapServer(data: object): string {
  return (data as { [RDAP_SERVER]?: string })[RDAP_SERVER] ?? "Unknown";
}
