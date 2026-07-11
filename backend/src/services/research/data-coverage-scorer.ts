import type { EvidenceItem } from './types';

/**
 * Coverage = weighted % of important report areas with at least one evidence
 * item at usable confidence. Drives the discovery loop (weak coverage → run
 * follow-up round) and explains in debug WHY a report has less data.
 */
export interface CoverageResult {
  coverageScore: number;
  missingCriticalFields: string[];
  missingUsefulFields: string[];
  recommendedNextActions: string[];
}

interface Area {
  name: string;
  fields: string[];
  weight: number;
  critical: boolean;
  recommendation: string;
}

const AREAS: Area[] = [
  { name: 'website', fields: ['official_website'], weight: 3, critical: true, recommendation: 'domain-resolution queries' },
  { name: 'contact', fields: ['email', 'phone', 'whatsapp', 'contact_form'], weight: 3, critical: true, recommendation: 'contact/privacy/legal page + PDF searches' },
  { name: 'address', fields: ['address'], weight: 2, critical: true, recommendation: 'contact/privacy crawl, registry search' },
  { name: 'socials', fields: ['linkedin', 'instagram', 'facebook', 'youtube', 'x_twitter', 'tiktok'], weight: 2, critical: true, recommendation: 'handle expansion + sameAs extraction' },
  { name: 'legal_identity', fields: ['legal_name', 'tax_id', 'registration_id', 'legal_entity_id'], weight: 2, critical: false, recommendation: 'registry queries (RFC/CIN/Companies House/SEC), GLEIF' },
  { name: 'industry', fields: ['industry'], weight: 1, critical: false, recommendation: 'directory/review queries' },
  { name: 'products', fields: ['products_services'], weight: 3, critical: true, recommendation: 'catalog/product/PDF crawl + product-name queries' },
  { name: 'people', fields: ['key_person'], weight: 2, critical: false, recommendation: 'role queries + site:linkedin.com/in searches' },
  { name: 'domain_dns', fields: ['domain_registered', 'dns', 'mx_provider'], weight: 1, critical: false, recommendation: 'RDAP/DNS lookups' },
  { name: 'tech_stack', fields: ['tech_stack'], weight: 1, critical: false, recommendation: 'public-file discovery + HTML fingerprinting' },
  { name: 'history_news', fields: ['history_event', 'news', 'founding_year'], weight: 2, critical: false, recommendation: 'Wayback + RSS + news queries' },
  { name: 'partners_clients', fields: ['client_partner', 'supplier', 'buyer', 'distributor'], weight: 2, critical: false, recommendation: 'partner/distributor/client queries' },
  { name: 'competitors', fields: ['competitor'], weight: 1, critical: false, recommendation: 'competitor/alternative/category queries' },
  { name: 'markets', fields: ['market_served'], weight: 1, critical: false, recommendation: 'country/region queries' },
];

const MIN_CONFIDENCE = 0.45;

export function scoreCoverage(evidence: EvidenceItem[]): CoverageResult {
  const present = new Set(
    evidence.filter((e) => e.confidence >= MIN_CONFIDENCE).map((e) => e.field as string),
  );

  let earned = 0;
  let total = 0;
  const missingCritical: string[] = [];
  const missingUseful: string[] = [];
  const actions: string[] = [];

  for (const area of AREAS) {
    total += area.weight;
    const covered = area.fields.some((f) => present.has(f));
    if (covered) {
      earned += area.weight;
    } else {
      (area.critical ? missingCritical : missingUseful).push(area.name);
      actions.push(area.recommendation);
    }
  }

  return {
    coverageScore: Math.round((earned / total) * 100),
    missingCriticalFields: missingCritical,
    missingUsefulFields: missingUseful,
    recommendedNextActions: [...new Set(actions)],
  };
}
