import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { extractDomain } from "@/lib/utils";
import { LookupError } from "./errors";

export type LookupQuery =
  | { kind: "domain"; value: string }
  | { kind: "ip"; value: string; address: string; version: 4 | 6 }
  | { kind: "asn"; value: string; number: number };

export function normalizeQuery(input: string): LookupQuery {
  const value = input.trim();
  const invalid = () =>
    new LookupError(
      "INVALID_QUERY",
      "Provide a valid domain, IP address, ASN or CIDR.",
    );
  if (!value || value.length > 2_048 || /\s|[\u0000-\u001f\u007f]/.test(value))
    throw invalid();

  if (/^(?:AS)?\d+$/i.test(value)) {
    const number = Number(value.replace(/^as/i, ""));
    if (!Number.isSafeInteger(number) || number < 0 || number > 4_294_967_295)
      throw invalid();
    return { kind: "asn", number, value: `AS${number}` };
  }

  const [address, prefix, ...extra] = value.split("/");
  const version = isIP(address);
  if (version === 4 || version === 6) {
    if (
      extra.length ||
      address.includes("%") ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw invalid();
    const canonical =
      version === 6
        ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
        : address;
    return {
      kind: "ip",
      address: canonical,
      version,
      value: canonical + (prefix === undefined ? "" : `/${Number(prefix)}`),
    };
  }

  let hostname = value;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    if (url.username || url.password) throw invalid();
    hostname = url.hostname;
    const ip = hostname.replace(/^\[|\]$/g, "");
    if (isIP(ip)) return normalizeQuery(ip);
  } else if (/[/:@?#\\]/.test(value)) {
    throw invalid();
  }
  hostname = domainToASCII(hostname.replace(/\.$/, "")).toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw invalid();
  const domain = extractDomain(hostname);
  if (!domain || !domain.includes(".") || /^\d+(?:\.\d+)+$/.test(hostname))
    throw invalid();
  return { kind: "domain", value: domainToASCII(domain).toLowerCase() };
}

export function ipNumber(address: string): bigint {
  if (isIP(address) === 4) {
    return address
      .split(".")
      .reduce((value, octet) => value * BigInt(256) + BigInt(octet), BigInt(0));
  }
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? start
      : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
  return groups.reduce(
    (value, group) => value * BigInt(65_536) + BigInt(parseInt(group, 16)),
    BigInt(0),
  );
}

export function matchesCidr(address: string, cidr: string): boolean {
  const [network, prefix] = cidr.split("/");
  const version = isIP(address);
  if (!version || version !== isIP(network) || !/^\d+$/.test(prefix ?? ""))
    return false;
  const bits = version === 4 ? 32 : 128;
  if (Number(prefix) > bits) return false;
  const shift = BigInt(bits - Number(prefix));
  return ipNumber(address) >> shift === ipNumber(network) >> shift;
}
