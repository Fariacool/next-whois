// These delegated UK namespaces do not use the ordinary .uk registry path.
// https://www.jisc.ac.uk/domain-registry
export function isJiscDomain(domain: string): boolean {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  return name === "ac.uk" || name.endsWith(".ac.uk");
}

// NHS England controls nhs.uk and its subdomains. A reply from Jisc or Nominet
// about a child is not evidence that the name is unregistered.
// https://digital.nhs.uk/services/networking-addressing
export function isNhsSubdomain(domain: string): boolean {
  return domain.trim().toLowerCase().replace(/\.$/, "").endsWith(".nhs.uk");
}

// Pin known registry endpoints for the namespaces covered by the fixtures.
// whoiser's uncached IANA discovery has a separate one-second timeout, which
// can fail before the otherwise reachable registry is queried.
// https://www.iana.org/domains/root/db/{il,pe,lv}.html
const REGISTRY_HOSTS: Record<string, string> = {
  il: "whois.isoc.org.il",
  pe: "kero.yachay.pe",
  lv: "whois.nic.lv",
};

export function knownRegistryHost(domain: string): string | undefined {
  const tld =
    domain.trim().toLowerCase().replace(/\.$/, "").split(".").pop() || "";
  return Object.hasOwn(REGISTRY_HOSTS, tld) ? REGISTRY_HOSTS[tld] : undefined;
}
