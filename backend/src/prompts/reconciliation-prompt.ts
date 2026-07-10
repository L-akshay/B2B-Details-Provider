import type { CompanyReport } from '../types/schema';

export function buildReconciliationPrompt(
  companyName: string,
  passA: CompanyReport | null,
  passB: CompanyReport | null,
  sourceUrls: string[],
): string {
  return `You are the final reconciliation stage of a company research pipeline for "${companyName}".
You are given up to two independently produced extraction passes (PASS A: fast structured extraction; PASS B: search-grounded extraction) plus the list of source URLs the pipeline actually consulted.

Produce ONE final JSON report by applying EXACTLY this rule set:
- A field present and matching in both passes → keep it, and where the schema has a "confidence" property set "confidence": "high".
- A field conflicting between passes → keep BOTH values (for addresses: two array entries, each with its own source_url; for plain string fields: format as "primary value (unverified; also reported: other value)"), set "confidence": "unverified" where the schema allows it, and list both source URLs.
- A field not found in any source → use "Not publicly available" for singular string fields ("" is NOT allowed for company_name), [] for arrays, and add the field name to "not_found". NEVER fabricate a value.

Additional constraints:
- emails: union of both passes, deduplicated by value; preserve "verified" flags (verified: true wins on conflict) and "source". Do not invent emails.
- phones / addresses / key_people: deduplicate near-identical entries (same digits, same person); keep the entry with the better source_url.
- recent_news: union, deduplicated by URL, most recent first, max 6.
- tech_stack / certifications / markets_served / notable_clients_partners / competitors / awards / office_locations: union, deduplicated.
- overview / history / business_model / target_customers / funding_and_financials: these are researched primarily by PASS B — keep them at FULL length and detail (do not summarize or shorten the overview); if only one pass has them, keep that pass's version verbatim.
- source_url values must come from the passes or the consulted-source list — never invent URLs.
- A pass that is null simply means that extraction pass failed; reconcile from the surviving pass and mark fields it alone supports as they are (do not downgrade them to unverified just because the other pass is missing).

CONSULTED SOURCES:
${sourceUrls.map((url) => `- ${url}`).join('\n')}

PASS A (fast structured extraction):
${passA ? JSON.stringify(passA, null, 2) : 'FAILED — not available'}

PASS B (search-grounded extraction):
${passB ? JSON.stringify(passB, null, 2) : 'FAILED — not available'}

Return the single reconciled JSON object only.`;
}
