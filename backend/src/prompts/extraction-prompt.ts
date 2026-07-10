import type { EvidenceBundle } from '../types/evidence';

/**
 * Per-pass evidence budgets. Groq's free tier caps openai/gpt-oss-120b at
 * 8,000 tokens per minute, so the request (input + max_tokens) must stay
 * under it; Gemini's flash tier is far roomier.
 */
interface EvidenceBudget {
  pageChars: number;
  digestChars: number;
}

export type ExtractionPass = 'groq' | 'gemini' | 'gemini-ungrounded' | 'llama-fallback';

const BUDGETS: Record<ExtractionPass, EvidenceBudget> = {
  groq: { pageChars: 1_700, digestChars: 3_800 },
  gemini: { pageChars: 6_000, digestChars: 100_000 },
  'gemini-ungrounded': { pageChars: 6_000, digestChars: 100_000 },
  // llama-3.3-70b free tier: 12k TPM counting input + max_tokens
  'llama-fallback': { pageChars: 2_500, digestChars: 5_000 },
};

function section(title: string, body: string): string {
  return `\n=== ${title} ===\n${body.trim()}\n`;
}

function renderEvidence(evidence: EvidenceBundle, budget: EvidenceBudget): string {
  const parts: string[] = [];
  const unavailable: string[] = [];

  if (evidence.compound.success && evidence.compound.data) {
    parts.push(
      section(
        'WEB SEARCH DIGEST (groq/compound, source URLs cited inline)',
        evidence.compound.data.digest.slice(0, budget.digestChars),
      ),
    );
  } else {
    unavailable.push(evidence.compound.error ?? 'web search digest');
  }

  if (evidence.site.success && evidence.site.data) {
    const pages = evidence.site.data.pages
      .map((page) => `--- PAGE (source_url: ${page.url}) ---\n${page.markdown.slice(0, budget.pageChars)}`)
      .join('\n\n');
    parts.push(section('OFFICIAL WEBSITE PAGES (scraped)', pages));
  } else {
    unavailable.push(evidence.site.error ?? 'website scrape');
  }

  if (evidence.wikidata.success && evidence.wikidata.data) {
    const w = evidence.wikidata.data;
    parts.push(
      section(
        `WIKIDATA STRUCTURED FACTS (source_url: ${evidence.wikidata.sourceUrl})`,
        [
          `entity: ${w.label} (${w.entityId}) — ${w.description}`,
          `official website: ${w.website ?? 'n/a'}`,
          `founded: ${w.founded ?? 'n/a'}`,
          `headquarters: ${w.headquarters ?? 'n/a'}${w.country ? `, ${w.country}` : ''}`,
          `industries: ${w.industries.join(', ') || 'n/a'}`,
          `CEO: ${w.ceo ?? 'n/a'}`,
          `founders: ${w.founders.join(', ') || 'n/a'}`,
          `legal form: ${w.legalForm ?? 'n/a'}`,
          `employees: ${w.employees ?? 'n/a'}`,
          `linkedin: ${w.linkedinUrl ?? 'n/a'}`,
          `twitter/x: ${w.twitter ?? 'n/a'}`,
          `facebook: ${w.facebook ?? 'n/a'}`,
          `instagram: ${w.instagram ?? 'n/a'}`,
        ].join('\n'),
      ),
    );
  } else {
    unavailable.push(evidence.wikidata.error ?? 'wikidata');
  }

  if (evidence.gleif.success && evidence.gleif.data) {
    const records = evidence.gleif.data
      .map((r) => `LEI ${r.lei} | legal name: ${r.legalName} | status: ${r.status} | legal address: ${r.address}`)
      .join('\n');
    parts.push(
      section(`GLEIF LEI REGISTRY RECORDS (source_url: ${evidence.gleif.sourceUrl})`, records),
    );
  } else {
    unavailable.push(evidence.gleif.error ?? 'gleif');
  }

  if (evidence.news.success && evidence.news.data) {
    const items = evidence.news.data
      .map((n) => `${n.date || 'undated'} | ${n.headline} | ${n.url}`)
      .join('\n');
    parts.push(section('RECENT NEWS (Google News RSS — real URLs and dates)', items));
  } else {
    unavailable.push(evidence.news.error ?? 'news');
  }

  if (evidence.registration.success && evidence.registration.data) {
    const r = evidence.registration.data;
    parts.push(
      section(
        `DOMAIN REGISTRATION (RDAP, source_url: ${evidence.registration.sourceUrl})`,
        `registered: ${r.registered ?? 'n/a'} (~${r.domainAgeYears ?? '?'} years old) | expires: ${r.expires ?? 'n/a'} | registrar: ${r.registrar ?? 'n/a'}`,
      ),
    );
  } else {
    unavailable.push(evidence.registration.error ?? 'rdap');
  }

  if (evidence.dns.success && evidence.dns.data) {
    const d = evidence.dns.data;
    parts.push(
      section(
        `DNS INTELLIGENCE (source: ${evidence.dns.sourceUrl})`,
        `email provider: ${d.emailProvider ?? 'unknown'}\nMX: ${d.mxHosts.join(', ') || 'none'}\nnameservers: ${d.nameservers.join(', ') || 'none'}\nSaaS hints from TXT records: ${d.saasHints.join('; ') || 'none'}`,
      ),
    );
  } else {
    unavailable.push(evidence.dns.error ?? 'dns');
  }

  if (evidence.tech.success && evidence.tech.data) {
    parts.push(
      section(
        `DETECTED WEBSITE TECH STACK (fingerprinted from ${evidence.tech.sourceUrl})`,
        evidence.tech.data.join(', '),
      ),
    );
  } else {
    unavailable.push(evidence.tech.error ?? 'tech stack');
  }

  if (evidence.cse.success && evidence.cse.data && evidence.cse.data.length > 0) {
    const hits = evidence.cse.data
      .map((hit) => `${hit.title} | ${hit.link}\n${hit.snippet}`)
      .join('\n---\n');
    parts.push(section('GOOGLE CUSTOM SEARCH RESULTS', hits));
  }

  const renderSocials = (profiles: object): string =>
    Object.entries(profiles as Record<string, string>)
      .map(([network, url]) => `${network}: ${url || 'not found'}`)
      .join('\n');

  parts.push(
    section(
      'SOCIAL PROFILES HARVESTED FROM THE WEBSITE ITSELF (authoritative)',
      renderSocials(evidence.socialHarvest),
    ),
  );
  if (evidence.socialSearch.success && evidence.socialSearch.data) {
    parts.push(
      section('SOCIAL PROFILES FOUND VIA WEB SEARCH', renderSocials(evidence.socialSearch.data)),
    );
  }

  const emails =
    evidence.contacts.emails
      .map((e) => `${e.value} | mx_verified: ${e.verified} | found on: ${e.source}`)
      .join('\n') || 'none found';
  parts.push(section('HARVESTED EMAILS (deterministic, MX-checked — the ONLY allowed emails)', emails));

  const phones =
    evidence.contacts.phones.map((p) => `${p.value} | found on: ${p.source_url}`).join('\n') ||
    'none found on website';
  parts.push(section('HARVESTED PHONES (from tel: links / international format)', phones));

  if (unavailable.length > 0) {
    parts.push(section('UNAVAILABLE SOURCES (do not guess their contents)', unavailable.join('\n')));
  }

  return parts.join('\n');
}

export function buildExtractionPrompt(evidence: EvidenceBundle, pass: ExtractionPass): string {
  const groundingNote =
    pass === 'gemini'
      ? `\nYou ALSO have Google Search available. Use it to (a) verify uncertain fields, (b) fill gaps the evidence does not cover — especially linkedin_url, key_people, certifications, tax/registration IDs and legal_name. When a fact comes from your own search instead of the evidence below, set its source_url to the URL you found it at.\n`
      : '\nUse ONLY the evidence below. Do not rely on memory of this company; if the evidence does not state a fact, it is not found.\n';

  return `You are a meticulous company research analyst. Extract a structured profile of the company "${evidence.companyName}"${
    evidence.extraInfo ? ` (requester context: ${evidence.extraInfo})` : ''
  } from the evidence sections below.
${groundingNote}
STRICT RULES:
1. NEVER fabricate. A field you cannot support with a source is "" (empty string) or [] and its name goes into "not_found".
2. EMAILS: copy exclusively from the HARVESTED EMAILS section, verbatim, with its mx_verified flag as "verified" and the found-on URL as "source". If that section says "none found", "emails" must be [].
3. Every address, phone and key person MUST include a source_url that appears in the evidence (or, for the search-grounded pass, a URL you actually found).
4. addresses[].confidence: "high" if from the official website, GLEIF, or Wikidata; otherwise "unverified".
5. recent_news: prefer RECENT NEWS section entries (they have real URLs and dates). 3-5 items, most recent first.
6. tech_stack: copy from DETECTED WEBSITE TECH STACK; you may add technologies explicitly evidenced elsewhere.
7. domain_registered / registrar: copy from DOMAIN REGISTRATION.
8. tax_id: only an explicitly published tax/registration identifier (GSTIN, CIN, EIN, VAT, company number). If none found but a GLEIF LEI exists, use "LEI: <code>". Otherwise "".
9. website: the official site (prefer ${evidence.domain ? `https://${evidence.domain}` : 'the domain evidenced above'}).
10. linkedin_url and social_links (facebook/instagram/twitter/youtube/tiktok/whatsapp): prefer the HARVESTED-FROM-WEBSITE profiles, then search-found ones; official company profiles only; "" when not found.
11. Dates as YYYY or YYYY-MM-DD. Phone numbers exactly as written in evidence.
12. description: 2-3 factual sentences describing what the company does, for whom, and where — grounded in the evidence, no marketing fluff.
13. products_services: concrete offerings named in the evidence (products, service lines, plans) — up to 10 items.
${
  pass === 'gemini-ungrounded' || pass === 'llama-fallback'
    ? `14. DEEP-DETAIL FIELDS (overview, history, business_model, target_customers, markets_served, notable_clients_partners, competitors, funding_and_financials, awards, office_locations): fill these from the evidence sections only — the search digest, website pages, Wikidata and news often contain history, partnerships, markets, branch locations and awards. The overview should be a detailed 2-4 paragraph factual profile assembled from the evidence. Extract whatever is genuinely there; "" or [] otherwise.`
    : pass === 'gemini'
    ? `14. DEEP-DETAIL FIELDS — research these thoroughly with search, they are the heart of the report:
   - overview: a DETAILED 2-4 paragraph factual profile — what the company does and how, its origin story, scale (offices, headcount, reach), market positioning, and anything distinctive. Write it like an analyst brief, not marketing copy.
   - history: key milestones as {"year", "event"} entries (founding, expansions, launches, acquisitions, leadership changes) — as many as you can verify.
   - business_model: how they make money (B2B/B2C, distribution, licensing, subscriptions…).
   - target_customers: who buys from them (segments, industries, institution types).
   - markets_served: countries/regions they operate or sell in.
   - notable_clients_partners: named customers, distribution partners, manufacturer partnerships.
   - competitors: direct competitors in their market.
   - funding_and_financials: funding rounds, investors, valuation, revenue — whatever is public; "" if private and undisclosed.
   - awards: awards, rankings, notable recognitions.
   - office_locations: every branch/office/city you can verify beyond the HQ.
   Facts only — anything you cannot verify stays out. Empty string / [] when nothing is found.`
    : `14. Set every deep-detail field (overview, history, business_model, target_customers, markets_served, notable_clients_partners, competitors, funding_and_financials, awards, office_locations) to "" or [] — a search-grounded pass fills them; spend your output budget on the core fields above.`
}

Return a single JSON object exactly matching the agreed schema. No prose, no markdown fences.

${renderEvidence(evidence, BUDGETS[pass])}`;
}
