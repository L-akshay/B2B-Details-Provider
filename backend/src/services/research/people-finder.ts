import { makeEvidence, type CrawledPage, type EvidenceItem, type SerpResult } from './types';

const ROLE_RE =
  /\b(CEO|CTO|CFO|COO|Chief\s+\w+\s+Officer|Founder|Co-?founder|President|Vice President|VP|Director(?:\s+General)?|Managing Director|General Manager|Gerente(?:\s+General)?|Presidente|Fundador|Socio|Partner|Head of \w+)\b/i;
// "Firstname Lastname" (supports accents), 2-3 words
const NAME_RE = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})\b/g;

const NON_PERSON =
  /\b(Privacy|Cookie|Terms|Contact|About|Home|Menu|Search|Login|Services|Products|Solutions|Company|Rights Reserved|Aviso|Política|Todos los|Managing Director|Chief|Officer|Before|After|As |New York|Life Sciences|Board|Team|Group|Capital|Sciences|Appoints|Breaks)\b/i;

// Common given-name/particle heuristics so "New York City" or "Managing
// Director" can't masquerade as a person. A real name has plausible casing
// and no corporate/geographic keywords.
const GEO_ORG_WORDS =
  /\b(City|York|Angeles|Francisco|Diego|Mexico|Guadalajara|Madrid|London|Inc|LLC|Ltd|Corp|Company|Sciences|Capital|Ventures|Partners|Group|Holdings|Solutions|Systems|Medical|Devices|Bio|Pharma)\b/i;

function looksLikePersonName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (GEO_ORG_WORDS.test(name)) return false;
  // every word must be Capitalized-then-lowercase (rejects ALLCAPS acronyms)
  return words.every((w) => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]+$/.test(w));
}

interface PersonHit {
  name: string;
  role: string;
  sourceUrl: string;
  sourceTitle?: string;
  evidenceText: string;
  confidence: number;
  fromLinkedIn?: boolean;
}

/**
 * People discovery from public SERP snippets and crawled team/about pages.
 * Uses only public URLs (linkedin.com/in profile links from search results),
 * never scrapes private LinkedIn pages. Weak name/company relations are
 * dropped.
 */
export function findPeople(
  companyName: string,
  serpResults: SerpResult[],
  pages: CrawledPage[],
): EvidenceItem[] {
  const hits = new Map<string, PersonHit>();
  const record = (hit: PersonHit) => {
    const key = hit.name.toLowerCase();
    const existing = hits.get(key);
    if (!existing || hit.confidence > existing.confidence) hits.set(key, hit);
  };

  // From SERP snippets that pair a name with a role
  for (const result of serpResults) {
    if (!/CEO|founder|director|leadership|president|team|gerente|fundador/i.test(result.query)) continue;
    const text = `${result.title} ${result.snippet ?? ''}`;
    const roleMatch = text.match(ROLE_RE);
    if (!roleMatch) continue;
    for (const nameMatch of text.matchAll(NAME_RE)) {
      const name = nameMatch[1]!;
      if (NON_PERSON.test(name) || !looksLikePersonName(name)) continue;
      const isLinkedIn = /linkedin\.com\/in/i.test(result.url);
      record({
        name,
        role: roleMatch[0],
        sourceUrl: result.url,
        sourceTitle: result.title,
        evidenceText: text.slice(0, 220),
        confidence: isLinkedIn ? 0.7 : 0.6,
        fromLinkedIn: isLinkedIn,
      });
      break; // one person per snippet (nearest name to the role)
    }
  }

  // From team/about pages of the official site
  for (const page of pages) {
    if (!['team', 'about', 'contact', 'home'].includes(page.kind)) continue;
    const windowText = page.text.slice(0, 8_000);
    for (const roleMatch of windowText.matchAll(new RegExp(ROLE_RE, 'gi'))) {
      const idx = roleMatch.index ?? 0;
      const around = windowText.slice(Math.max(0, idx - 60), idx + 60);
      const nameMatch = around.match(NAME_RE);
      if (!nameMatch) continue;
      const name = nameMatch[0];
      if (NON_PERSON.test(name) || !looksLikePersonName(name)) continue;
      record({
        name,
        role: roleMatch[0],
        sourceUrl: page.finalUrl,
        sourceTitle: page.title,
        evidenceText: around.replace(/\s+/g, ' ').trim(),
        confidence: page.kind === 'team' ? 0.85 : 0.75,
      });
    }
  }

  return [...hits.values()].map((hit) =>
    makeEvidence({
      field: 'key_person',
      value: hit.name,
      sourceUrl: hit.sourceUrl,
      sourceTitle: hit.sourceTitle,
      sourceType: hit.fromLinkedIn ? 'social' : 'official_website',
      extractedBy: hit.fromLinkedIn ? 'serp' : 'cheerio',
      confidence: hit.confidence,
      evidenceText: hit.evidenceText,
      metadata: { role: hit.role },
    }),
  );
}
