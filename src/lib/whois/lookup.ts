import { WhoisResult, WhoisAnalyzeResult } from "./types";
import { analyzeWhois } from "./common_parser";
import { lookupRdap, convertRdapToWhoisResult } from "./rdap_client";
import { isJiscDomain, isNhsSubdomain } from "./domain_routes";
import { LOOKUP_TIMEOUT_MS } from "./config";
import { isTerminalError, LookupError, upstreamError } from "./errors";
import { normalizeQuery } from "./query";
import { isRdapRecord } from "./rdap_lookup";
import { lookupRawWhois } from "./whois_client";
import { WhoisLookupService } from "./service";

const WHOIS_ERROR_PATTERNS = [
  /no match/i,
  /not found/i,
  /no data found/i,
  /no entries found/i,
  /no object found/i,
  /nothing found/i,
  /invalid query/i,
  /error:/i,
  /malformed/i,
  /object does not exist/i,
  /domain not found/i,
  /status:\s*free/i,
  /status:\s*available/i,
  /is available for/i,
  /no whois information/i,
  /tld is not supported/i,
  /^no such domain(?:\s|$)/i,
  /WHOIS LIMIT EXCEEDED/i,
  /query limit exceeded/i,
];

function isIanaFallback(raw: string): boolean {
  return raw.includes("% IANA WHOIS server");
}

function detectWhoisError(raw: string): string | null {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("%") &&
        !l.startsWith("#") &&
        !l.startsWith(">>>") &&
        !l.startsWith("NOTICE") &&
        !l.startsWith("TERMS OF USE"),
    );
  if (lines.length === 0) return "Empty WHOIS response";

  for (const pattern of WHOIS_ERROR_PATTERNS) {
    const matchLine = lines.find((line) => pattern.test(line));
    if (matchLine) return matchLine;
  }
  return null;
}

function isEmptyResult(result: {
  domain: string;
  registrar: string;
  creationDate: string;
  expirationDate: string;
  updatedDate: string;
  status: WhoisAnalyzeResult["status"];
  nameServers: string[];
  cidr: string;
  netRange: string;
  netName: string;
  originAS: string;
  inetNum: string;
  inet6Num: string;
}): boolean {
  const hasIpData =
    (result.cidr && result.cidr !== "Unknown") ||
    (result.netRange && result.netRange !== "Unknown") ||
    (result.netName && result.netName !== "Unknown") ||
    (result.originAS && result.originAS !== "Unknown") ||
    (result.inetNum && result.inetNum !== "Unknown") ||
    (result.inet6Num && result.inet6Num !== "Unknown");
  if (hasIpData) return false;

  return (
    (!result.domain || result.domain === "") &&
    result.registrar === "Unknown" &&
    result.creationDate === "Unknown" &&
    result.expirationDate === "Unknown" &&
    result.updatedDate === "Unknown" &&
    result.status.length === 0 &&
    result.nameServers.length === 0
  );
}

export async function lookupWhois(
  input: string,
  signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
): Promise<WhoisResult> {
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1_000;
  try {
    const query = normalizeQuery(input);
    if (query.kind === "domain" && isNhsSubdomain(query.value)) {
      return {
        status: false,
        time: elapsed(),
        cached: false,
        error:
          "Unsupported WHOIS/RDAP namespace: NHS-managed .nhs.uk subdomains",
      };
    }
    signal.throwIfAborted();
    if (!(query.kind === "domain" && isJiscDomain(query.value))) {
      try {
        const data = await lookupRdap(query.value, signal);
        if (isRdapRecord(data, query)) {
          const result = await convertRdapToWhoisResult(
            data,
            query.value,
            signal,
          );
          signal.throwIfAborted();
          return {
            status: true,
            time: elapsed(),
            cached: false,
            source: "rdap",
            result,
          };
        }
      } catch (error) {
        if (isTerminalError(error) || signal.aborted) throw error;
      }
    }
    signal.throwIfAborted();
    const { raw, server } = await lookupRawWhois(query, signal);
    if (isIanaFallback(raw))
      throw new LookupError(
        "LOOKUP_FAILED",
        "No WHOIS/RDAP server available for this TLD",
      );
    const whoisError = detectWhoisError(raw);
    if (whoisError) {
      const message = /^no such domain(?:\s|$)/i.test(whoisError)
        ? `No match for domain "${query.value}" (Jisc: ${whoisError})`
        : whoisError;
      return {
        status: false,
        time: elapsed(),
        cached: false,
        source: "whois",
        error: message,
      };
    }
    const result = await analyzeWhois(raw, query.value, signal);
    signal.throwIfAborted();
    if (isEmptyResult(result))
      throw new LookupError("LOOKUP_FAILED", "Empty WHOIS response");
    if (!result.domain) result.domain = query.value;
    if (!result.whoisServer || result.whoisServer === "Unknown")
      result.whoisServer = server;
    return {
      status: true,
      time: elapsed(),
      cached: false,
      source: "whois",
      result,
    };
  } catch (error) {
    const failure = upstreamError(error, signal);
    return {
      status: false,
      time: elapsed(),
      cached: false,
      error: failure.message,
      errorCode: failure.code,
      ...(failure.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
    };
  }
}

const processState = globalThis as typeof globalThis & {
  nextWhoisLookupService?: WhoisLookupService;
};

export function lookupService() {
  // Next.js can compile the single and batch routes into separate module graphs.
  return (processState.nextWhoisLookupService ??= new WhoisLookupService(
    lookupWhois,
  ));
}

export async function lookupWhoisWithCache(
  input: string,
): Promise<WhoisResult> {
  return lookupService().lookup(input);
}

export async function lookupWhoisBatch(inputs: string[]) {
  return lookupService().batch(inputs);
}
