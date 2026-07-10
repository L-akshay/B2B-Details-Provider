import { makeEvidence, type CrawledPage, type EvidenceItem, type SerpResult } from './types';

/**
 * B2B relationship discovery for lead enrichment: classifies the company's
 * suppliers, buyers/clients, distributors, and partners from (a) SERP results
 * of relationship-intent queries and (b) the company's own crawled pages
 * (partner/client/distributor sections). Evidence only — names are extracted
 * from public snippets and pages, never invented, and kept low-to-mid
 * confidence unless they appear on the official site.
 */

const NON_ENTITY =
  /\b(Home|About|Contact|Privacy|Terms|Products?|Services?|Best|Top \d+|Guide|Review|List|Companies|Directory|Menu|Search|Login|News|Blog|More|Read|View|Click|Cookie|Rights? Reserved)\b/i;

const ENTITY_RE =
  /\b([A-ZÁÉÍÓÚÑ][\wáéíóúñ&.-]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ&.-]+|de|del|y|and|&)){0,3}(?:\s+(?:S\.?A\.?(?:\s+de\s+C\.?V\.?)?|Inc|LLC|Ltd|GmbH|Corp|Co|SL|SRL))?)\b/g;

type Relation = 'supplier' | 'buyer' | 'distributor' | 'client_partner';

function relationForQuery(query: string): Relation | null {
  const q = query.toLowerCase();
  if (/supplier|proveedor/.test(q)) return 'supplier';
  if (/distributor|distribuidor|dealer/.test(q)) return 'distributor';
  if (/client|customer|buyer|cliente/.test(q)) return 'buyer';
  if (/partner/.test(q)) return 'client_partner';
  return null;
}

function relationForPagePath(url: string): Relation | null {
  const p = url.toLowerCase();
  if (/distribuidor|distributor|dealer/.test(p)) return 'distributor';
  if (/proveedor|supplier/.test(p)) return 'supplier';
  if (/client|cliente|customer/.test(p)) return 'buyer';
  if (/partner|socio|alianza/.test(p)) return 'client_partner';
  return null;
}

function extractEntities(text: string, selfTokens: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ENTITY_RE)) {
    const name = m[1]!.trim().replace(/\s+/g, ' ');
    const lower = name.toLowerCase();
    if (name.length < 4 || name.length > 60) continue;
    if (NON_ENTITY.test(name)) continue;
    if (selfTokens.some((t) => lower.includes(t))) continue; // the company itself
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
    if (out.length >= 3) break; // a few per source keeps noise down
  }
  return out;
}

export function findBusinessRelations(
  companyName: string,
  serpResults: SerpResult[],
  pages: CrawledPage[],
  selectedDomain?: string,
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const selfTokens = companyName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);

  // (a) From relationship-intent SERP snippets
  for (const result of serpResults) {
    if (result.intent !== 'competitors') continue;
    const relation = relationForQuery(result.query);
    if (!relation) continue;
    const text = `${result.title} — ${result.snippet ?? ''}`;
    for (const name of extractEntities(text, selfTokens, seen)) {
      evidence.push(
        makeEvidence({
          field: relation,
          value: name,
          sourceUrl: result.url,
          sourceTitle: result.title,
          sourceType: 'search_result',
          extractedBy: 'serp',
          confidence: 0.5,
          verified: 'low_confidence',
          evidenceText: text.slice(0, 200),
          query: result.query,
        }),
      );
      if (evidence.length >= 40) return evidence;
    }
  }

  // (b) From the company's own partner/client/distributor pages (higher trust)
  for (const page of pages) {
    const relation = relationForPagePath(page.finalUrl ?? page.url);
    if (!relation) continue;
    const onDomain = selectedDomain ? (page.finalUrl ?? page.url).includes(selectedDomain) : true;
    for (const name of extractEntities(page.text.slice(0, 4_000), selfTokens, seen)) {
      evidence.push(
        makeEvidence({
          field: relation,
          value: name,
          sourceUrl: page.finalUrl ?? page.url,
          sourceTitle: page.title,
          sourceType: 'official_website',
          extractedBy: 'cheerio',
          confidence: onDomain ? 0.75 : 0.55,
          evidenceText: `Listed on the company's ${relation} page`,
        }),
      );
      if (evidence.length >= 40) return evidence;
    }
  }

  return evidence;
}
