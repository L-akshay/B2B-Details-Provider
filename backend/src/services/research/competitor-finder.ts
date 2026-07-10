import { makeEvidence, type CrawledPage, type EvidenceItem, type SerpResult } from './types';

const COMPARISON_HOSTS = /crunchbase|owler|g2\.com|capterra|similarweb|comparably|clutch\.co/i;
const NON_COMPANY =
  /\b(Home|About|Contact|Privacy|News|Blog|Products|Services|Best|Top \d+|Guide|Review|List of|Companies|Directory)\b/i;

/**
 * Competitor discovery from comparison-oriented search results ("companies
 * similar to X", "{industry} companies in {country}"). Competitors are
 * inherently lower-confidence unless sourced from a credible comparison site;
 * this only emits evidence, never invents names.
 */
export function findCompetitors(
  companyName: string,
  serpResults: SerpResult[],
  _pages: CrawledPage[],
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const selfTokens = companyName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);

  for (const result of serpResults) {
    if (result.intent !== 'competitors') continue;
    let host = '';
    try {
      host = new URL(result.url).hostname;
    } catch {
      continue;
    }
    const credible = COMPARISON_HOSTS.test(host);
    const text = `${result.title} — ${result.snippet ?? ''}`;

    // Pull capitalized multi-word names from comparison snippets
    for (const match of text.matchAll(/\b([A-ZÁÉÍÓÚÑ][\wáéíóúñ&.-]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ&.-]+){0,2})\b/g)) {
      const name = match[1]!.trim();
      const lower = name.toLowerCase();
      if (name.length < 3 || NON_COMPANY.test(name)) continue;
      if (selfTokens.some((t) => lower.includes(t))) continue; // it's the company itself
      if (seen.has(lower)) continue;
      seen.add(lower);
      evidence.push(
        makeEvidence({
          field: 'competitor',
          value: name,
          sourceUrl: result.url,
          sourceTitle: result.title,
          sourceType: credible ? 'third_party_directory' : 'search_result',
          extractedBy: 'serp',
          confidence: credible ? 0.6 : 0.4,
          verified: 'low_confidence',
          evidenceText: text.slice(0, 200),
          query: result.query,
        }),
      );
      if (evidence.length >= 12) return evidence;
    }
  }

  return evidence;
}
