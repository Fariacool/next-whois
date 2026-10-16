# WHOIS parser fixtures

These are minimized, anonymized excerpts of port 43 responses observed on
2026-10-16. They preserve registry field names, indentation, dates and metadata
boundaries. Contact details, identifiers and legal boilerplate unrelated to the
parser are omitted; these are not complete, byte-identical response archives.
`il.txt` replaces contact addresses; `lv.txt` replaces the holder and its number
(with a date-shaped identifier for a negative test).

| File | Authority queried | Query | Expected lifecycle data |
| --- | --- | --- | --- |
| au.txt | whois.auda.org.au | 13cabs.com.au | Last Modified only; database footer ignored |
| il.txt | whois.isoc.org.il | 019mobile.co.il | assigned / validity; mixed changed records ignored |
| pe.txt | kero.yachay.pe | abril.pe | No lifecycle dates; database footer ignored |
| lv.txt | whois.nic.lv | 1a.lv | No lifecycle dates; [Whois] Updated ignored |
| jisc.txt | whois.ja.net | abdn.ac.uk | Entry created / updated / Renewal date |
| nhs-jisc.txt | whois.ja.net | digital.nhs.uk | Wrong authority; not evidence of non-registration |

The unit tests also mutate these excerpts to exercise malformed dates, bare
eight-digit identifiers, missing dates and other suffixes in the same namespace.
Those mutations are synthetic cases, not additional live observations.

Policy and ownership sources:

- [auDA WHOIS Policy 2025-11, §4.5 and Schedule A](https://www.auda.org.au/au-domain-names/au-rules-and-policies/whois-policy-2025-11/)
- [NIC.LV WHOIS Policy, §§4–5](https://www.nic.lv/en/nic-whois-policy)
- [ISOC-IL policy update](https://en.isoc.org.il/il-cctld/registry-updatesnews/whois_policy_update_2026)
- [Jisc domain registry](https://www.jisc.ac.uk/domain-registry)
- [NHS namespace ownership](https://digital.nhs.uk/services/networking-addressing)
- [NHS apex and subdomains](https://digital.nhs.uk/services/health-and-social-care-network/hscn-technical-guidance/dns)

The Peru excerpt proves only that this response had no lifecycle fields; it is
not evidence that the registry has a permanent non-disclosure policy.
