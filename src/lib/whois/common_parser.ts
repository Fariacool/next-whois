import {
  DomainStatusProps,
  initialWhoisAnalyzeResult,
  WhoisAnalyzeResult,
} from "@/lib/whois/types";
import { includeArgs } from "@/lib/utils";
import moment from "moment";
import { getMozMetrics } from "@/lib/moz/client";
import { getDomainPricing } from "@/lib/pricing/client";
import { lifecycleField, parseWhoisDate } from "./lifecycle_dates";

function analyzeDomainStatus(status: string): DomainStatusProps {
  const segments = status.split(" ");
  let url = segments.slice(1).join(" ");

  url.startsWith("(") && url.endsWith(")") && (url = url.slice(1, -1));
  return {
    status: segments[0],
    url,
  };
}

function calculateDomainAge(creationDate: string): number {
  if (creationDate === "Unknown") return 0;

  const created = moment(creationDate);
  const now = moment();

  return now.diff(created, "years");
}

function calculateRemainingDays(expirationDate: string): number {
  if (expirationDate === "Unknown") return 0;

  const expiry = moment(expirationDate);
  const now = moment();

  return Math.max(0, expiry.diff(now, "days"));
}

export async function applyParams(
  result: WhoisAnalyzeResult,
  signal?: AbortSignal,
) {
  // Calculate domain age and remaining days
  result.domainAge =
    !result.creationDate || result.creationDate === "Unknown"
      ? null
      : calculateDomainAge(result.creationDate);
  result.remainingDays =
    !result.expirationDate || result.expirationDate === "Unknown"
      ? null
      : calculateRemainingDays(result.expirationDate);

  // Get pricing information
  result.registerPrice = await getDomainPricing(result.domain, "new", signal);
  result.renewPrice = await getDomainPricing(result.domain, "renew", signal);
  result.transferPrice = await getDomainPricing(
    result.domain,
    "transfer",
    signal,
  );

  // Get Moz metrics
  const mozMetrics = await getMozMetrics(result.domain, signal);
  result.mozDomainAuthority = mozMetrics.domainAuthority;
  result.mozPageAuthority = mozMetrics.pageAuthority;
  result.mozSpamScore = mozMetrics.spamScore;

  return result;
}

export function parseWhois(data: string, query = ""): WhoisAnalyzeResult {
  const lines = data.split(/\r?\n/);

  const result: WhoisAnalyzeResult = {
    ...initialWhoisAnalyzeResult,
    status: [],
    nameServers: [],
    rawWhoisContent: data,
  };

  let section = "";
  let contactRecord = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[%#;*>]/.test(line)) continue;

    if (/^domain information:$/i.test(line)) {
      section = "";
      contactRecord = false;
      continue;
    }
    if (/^contact information:$/i.test(line)) {
      section = "contact";
      contactRecord = true;
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    let key: string;
    let value: string;

    const bracketMatch = line.match(/^(?:[a-z]\.\s*)?\[(.+?)\]\s+(.+)/);
    if (bracketMatch) {
      key = bracketMatch[1].trim().toLowerCase();
      value = bracketMatch[2].trim();
    } else {
      let segments = line.split(":");
      if (segments.length < 2) continue;
      if (segments.length >= 3 && segments[0].toLowerCase() === "network") {
        segments = segments.slice(1);
      }
      key = segments[0].trim().toLowerCase();
      value = segments.slice(1).join(":").trim();
    }

    // Preserve indentation until multiline registry fields have been read.
    if (!value) {
      const values: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        // A nested labelled field belongs to the next iteration.
        if (/^\s*[^:]+:\s/.test(lines[i + 1])) break;
        values.push(lines[++i].trim());
      }
      if (key === "servers" || key === "name servers") {
        result.nameServers.push(
          ...values.map((entry) => entry.split(/\s+/)[0]),
        );
        continue;
      }
      value = values.join(" ");
    }
    if (!value) continue;
    key = key.replace(/\.+$/, "").replace(/\s+/g, " ").trim();

    if (
      /^(?:nic-hdl(?:-[a-z]+)?|jpnic handle|person|role|contact|admin e-mail|tech e-mail)$/.test(
        key,
      )
    ) {
      contactRecord = true;
    } else if (key === "domain" || key === "domain name") {
      contactRecord = false;
    }

    const isIl = (query || result.domain).toLowerCase().endsWith(".il");
    let field = lifecycleField(key);
    if (isIl && key === "assigned") field = "creationDate";
    if (isIl && key === "validity") field = "expirationDate";
    if (field) {
      // [Whois] Updated is a database timestamp, and contact object dates do
      // not describe the domain. Leave such metadata in rawWhoisContent.
      if ((section && section !== "domain") || contactRecord) continue;
      if (isIl && key === "changed") {
        // Legacy IL assignment history has a defined marker. Other changed
        // lines include contact changes and registrar IDs, not domain dates.
        const assigned = value.match(
          /^domain-registrar AT isoc\.org\.il (\d{8}) \(Assigned\)$/i,
        );
        if (assigned && result.creationDate === "Unknown") {
          result.creationDate = parseWhoisDate(assigned[1]) || "Unknown";
        }
        continue;
      }
      const parsed = parseWhoisDate(value);
      if (parsed) result[field] = parsed;
      continue;
    }

    switch (key) {
      case "domain name":
      case "domain":
        result.domain = value;
        break;
      case "registrar":
      case "authorized agency":
      case "sponsoring registrar":
      case "registrar name":
      case "registered by":
        result.registrar = value;
        break;
      case "registrar url":
        result.registrarURL = value;
        break;
      case "iana id":
        result.ianaId = value;
        break;
      case "registrar iana id":
        result.ianaId = value;
        break;
      case "whois server":
        result.whoisServer = value;
        break;
      case "whois":
        result.whoisServer = value;
        break;
      case "registrar whois server":
        result.whoisServer = value;
        break;
      case "state": {
        // JPRS explicitly defines this field's parenthesized date as expiry.
        // Require its complete registered-state grammar and a JP domain.
        // https://jprs.jp/about/dom-search/jprs-whois/whois-guide-view.html
        const expiry = value.match(
          /^(?:Connected|Registered) \((\d{4}\/\d{2}\/\d{2})\)$/,
        );
        if (
          expiry &&
          /\.jp$/i.test(query || result.domain) &&
          !contactRecord &&
          (!section || section === "domain") &&
          result.expirationDate === "Unknown"
        ) {
          result.expirationDate = parseWhoisDate(expiry[1]) || "Unknown";
        }
        result.status.push(analyzeDomainStatus(value));
        break;
      }
      case "status":
      case "registration status":
        result.status.push(analyzeDomainStatus(value));
        break;
      case "domain status":
        result.status.push(analyzeDomainStatus(value));
        break;
      case "name server":
      case "host name":
        result.nameServers.push(value);
        break;
      case "nameservers":
        result.nameServers.push(value);
        break;
      case "nserver":
        result.nameServers.push(value.split(/\s+/)[0]);
        break;
      case "registrant name":
        result.registrantOrganization = value;
        break;
      case "registrant organization":
        result.registrantOrganization = value;
        break;
      case "organization":
        result.registrantOrganization = value;
        break;
      case "organisation":
        result.registrantOrganization = value;
        break;
      case "org-name":
        result.registrantOrganization = value;
        break;
      case "registrant":
      case "registered for":
      case "domain owner":
        result.registrantOrganization = value;
        break;
      case "name":
        if (section === "registrar") result.registrar = value;
        if (section === "holder") result.registrantOrganization = value;
        break;
      case "descr":
        result.registrantOrganization === "Unknown" &&
          (result.registrantOrganization = value);
        break;
      case "registrant state/province":
        result.registrantProvince = value;
        break;
      case "city":
        result.registrantProvince = value;
        break;
      case "registrant country":
        result.registrantCountry = value;
        break;
      case "country":
        result.registrantCountry = value;
        break;
      case "registrant phone":
        result.registrantPhone = value.replace("tel:", "").replace(".", " ");
        break;
      case "registrar abuse contact phone":
      case "ac phone number":
        result.registrantPhone = value.replace("tel:", "").replace(".", " ");
        break;
      case "orgtechphone":
        result.registrantPhone = value;
        break;
      case "registrant email":
        result.registrantEmail = value.replace(
          "Select Request Email Form at ",
          "",
        );
        break;
      case "dnssec":
        result.dnssec = value;
        break;
      case "email":
      case "ac e-mail":
        result.registrantEmail = value;
        break;
      case "e-mail":
        result.registrantEmail === "Unknown" &&
          (result.registrantEmail = value);
        break;
      case "cidr":
        result.cidr = value;
        break;
      case "inetnum":
        result.inetNum = value;
        break;
      case "inet6num":
        result.inet6Num = value;
        break;
      case "netrange":
        result.netRange = value;
        break;
      case "netname":
        result.netName = value;
        break;
      case "network-name":
        result.netName = value;
        break;
      case "nettype":
        result.netType = value;
        break;
      case "originas":
        result.originAS = value;
        break;
      case "origin":
        result.originAS = value;
        break;
    }

    if (includeArgs(key, "domain name") && !result.domain) {
      result.domain = value;
    } else if (
      includeArgs(key, "registrar") &&
      result.registrar === "Unknown"
    ) {
      result.registrar = value;
    } else if (
      includeArgs(key, "contact email") &&
      result.registrantEmail === "Unknown"
    ) {
      result.registrantEmail = value;
    } else if (
      includeArgs(key, "contact phone") &&
      result.registrantPhone === "Unknown"
    ) {
      result.registrantPhone = value;
    } else if (
      includeArgs(key, "account name", "registrant org") &&
      result.registrantOrganization === "Unknown"
    ) {
      result.registrantOrganization = value;
    }
  }

  let newStatus: DomainStatusProps[] = [];
  for (let i = 0; i < result.status.length; i++) {
    const status = result.status[i];
    if (newStatus.find((item) => item.status === status.status)) continue;
    newStatus.push(status);
  }
  result.status = newStatus;
  result.nameServers = Array.from(new Set(result.nameServers));

  return result;
}

export async function analyzeWhois(
  data: string,
  query = "",
  signal?: AbortSignal,
): Promise<WhoisAnalyzeResult> {
  return await applyParams(parseWhois(data, query), signal);
}
