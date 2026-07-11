import type { CrawledPage, EvidenceItem } from './types';
import type { CoverageResult } from './data-coverage-scorer';
import type { EntitySeeds } from './entity-seed-extractor';

/**
 * Decides which optional public sources and query packs are worth spending
 * budget on for THIS company (country, industry signals, what's missing).
 * Every decision is recorded with a reason for the debug output — when the
 * report has less data, this shows what was tried vs. deliberately skipped.
 */
export type RoutedSource = 'wayback' | 'sec_edgar' | 'openalex' | 'public_files';
export type QueryPack = 'registry' | 'careers' | 'reviews' | 'apps' | 'software' | 'ip' | 'certifications';

export interface SourcePlan {
  sources: RoutedSource[];
  packs: QueryPack[];
  selected: Array<{ source: string; reason: string }>;
  skipped: Array<{ source: string; reason: string }>;
}

const SOFTWARE_HINTS = /\b(saas|software|api|sdk|developer|platform|app|cloud|ai|machine learning|devtool|github)\b/i;
const RESEARCH_HINTS = /\b(biotech|medtech|pharma|medical|research|clinical|laborator|university|scien|health)\b/i;
const US_HINTS = /\b(usa|united states|delaware|california|new york|inc\.?|nasdaq|nyse|sec)\b/i;

export function routeSources(input: {
  companyName: string;
  seeds: EntitySeeds;
  coverage: CoverageResult;
  evidence: EvidenceItem[];
  pages: CrawledPage[];
  selectedDomain?: string;
}): SourcePlan {
  const { seeds, coverage, evidence, pages } = input;
  const selected: SourcePlan['selected'] = [];
  const skipped: SourcePlan['skipped'] = [];
  const sources: RoutedSource[] = [];
  const packs: QueryPack[] = [];

  const corpus = [
    input.companyName,
    ...evidence.filter((e) => e.field === 'industry' || e.field === 'description').map((e) => e.value),
    pages
      .slice(0, 5)
      .map((p) => `${p.title} ${p.text.slice(0, 1_500)}`)
      .join(' '),
  ]
    .join(' ')
    .toLowerCase();
  const missing = new Set([...coverage.missingCriticalFields, ...coverage.missingUsefulFields]);
  const country = (seeds.countries[0] ?? '').toLowerCase();
  const totalText = pages.reduce((s, p) => s + p.text.length, 0);

  const pick = (list: string[], name: string, reason: string, target: RoutedSource | QueryPack, into: 'src' | 'pack') => {
    selected.push({ source: name, reason });
    if (into === 'src') sources.push(target as RoutedSource);
    else packs.push(target as QueryPack);
    void list;
  };

  // Public files: always when a domain exists — cheap, deterministic, high yield.
  if (input.selectedDomain) pick([], 'public_files', 'domain selected; security.txt/wp-json/RSS are cheap', 'public_files', 'src');
  else skipped.push({ source: 'public_files', reason: 'no selected domain' });

  // Wayback: when history is missing, or the live site gave little text.
  if (missing.has('history_news') || totalText < 15_000) {
    pick([], 'wayback', missing.has('history_news') ? 'history/news missing' : 'live crawl text is thin', 'wayback', 'src');
  } else skipped.push({ source: 'wayback', reason: 'history covered and live site rich' });

  // SEC EDGAR: only with US signals.
  if (US_HINTS.test(corpus) || /us/.test(country)) {
    pick([], 'sec_edgar', 'US signals detected', 'sec_edgar', 'src');
  } else skipped.push({ source: 'sec_edgar', reason: 'no US signals' });

  // OpenAlex: research/medical/AI organizations publish; others don't.
  if (RESEARCH_HINTS.test(corpus)) {
    pick([], 'openalex', 'research/medical/AI signals detected', 'openalex', 'src');
  } else skipped.push({ source: 'openalex', reason: 'no research signals' });

  // Query packs
  if (missing.has('legal_identity')) pick([], 'registry_queries', 'legal identity missing', 'registry', 'pack');
  else skipped.push({ source: 'registry_queries', reason: 'legal identity present' });

  pick([], 'review_queries', 'directories corroborate identity cheaply', 'reviews', 'pack');
  pick([], 'certification_queries', 'certifications matter for B2B trust', 'certifications', 'pack');

  if (SOFTWARE_HINTS.test(corpus)) {
    pick([], 'software_queries', 'software/SaaS signals', 'software', 'pack');
    pick([], 'app_queries', 'software company may ship apps', 'apps', 'pack');
  } else {
    skipped.push({ source: 'software_queries', reason: 'no software signals' });
    skipped.push({ source: 'app_queries', reason: 'no app signals' });
  }

  if (seeds.productNames.length > 0) pick([], 'ip_queries', 'named products may have patents/trademarks', 'ip', 'pack');
  else skipped.push({ source: 'ip_queries', reason: 'no product names discovered' });

  pick([], 'careers_queries', 'hiring signals show scale and roles', 'careers', 'pack');

  return { sources, packs, selected, skipped };
}
