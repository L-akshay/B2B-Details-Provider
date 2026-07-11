import type { GeneratedQuery } from './search-query-generator';
import type { EntitySeeds } from './entity-seed-extractor';
import type { CoverageResult } from './data-coverage-scorer';
import type { SourcePlan } from './source-router';

/**
 * Round-2 discovery queries built from round-0 SEEDS + MISSING fields.
 * A discovered legal name, handle, or product name makes far sharper queries
 * than the raw company name; missing areas decide which packs get priority so
 * the budget goes where data is actually absent.
 */
export function generateFollowUpQueries(
  companyName: string,
  seeds: EntitySeeds,
  coverage: CoverageResult,
  plan: SourcePlan,
  country?: string,
): GeneratedQuery[] {
  const queries: GeneratedQuery[] = [];
  const seen = new Set<string>();
  const add = (intent: GeneratedQuery['intent'], query: string, priority: number) => {
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ intent, query, priority });
  };
  const missing = new Set([...coverage.missingCriticalFields, ...coverage.missingUsefulFields]);
  const brand = seeds.brandNames[0] ?? companyName;
  const legal = seeds.legalNames[0];
  const domain = seeds.domains[0];

  // Legal identity via registries (country-aware public-search routing)
  if (missing.has('legal_identity') && plan.packs.includes('registry')) {
    if (legal) {
      add('business', `"${legal}" registration`, 90);
      add('business', `"${legal}" company registry`, 85);
    }
    const c = (country ?? seeds.countries[0] ?? '').toLowerCase();
    if (/mex|mx/.test(c)) {
      add('business', `"${brand}" RFC razón social`, 88);
      add('business', `"${brand}" "S.A. de C.V."`, 84);
    } else if (/india|in\b/.test(c)) {
      add('business', `"${brand}" CIN MCA`, 88);
      add('business', `"${brand}" GST Udyam`, 84);
    } else if (/uk|united kingdom|brit/.test(c)) {
      add('business', `"${brand}" Companies House company number`, 88);
    } else if (/us|united states|usa/.test(c)) {
      add('business', `"${brand}" SEC CIK state business registry`, 84);
    } else {
      add('business', `"${brand}" company registry legal entity`, 80);
    }
  }

  // Contact via legal name / email domain (privacy pages carry contacts)
  if (missing.has('contact')) {
    if (legal) add('contact', `"${legal}" email teléfono contacto`, 92);
    if (domain) add('contact', `site:${domain} contacto OR contact OR "aviso de privacidad"`, 90);
    for (const dom of seeds.emailDomains.slice(0, 2)) add('contact', `"@${dom}" contact`, 82);
  }

  // Socials via handles
  if (missing.has('socials')) {
    for (const handle of seeds.socialHandles.slice(0, 3)) {
      add('social', `"${handle}" LinkedIn OR Instagram OR Facebook OR YouTube`, 88);
    }
    add('social', `"${brand}" site:linkedin.com/company`, 86);
  }

  // People via role queries and known names
  if (missing.has('people')) {
    add('people', `"${brand}" CEO OR founder OR "director general"`, 84);
    add('people', `site:linkedin.com/in "${brand}"`, 86);
    for (const person of seeds.peopleNames.slice(0, 2)) add('people', `"${person}" "${brand}"`, 80);
  }

  // Products via catalog/PDF and product-name pivots
  if (missing.has('products')) {
    add('documents', `"${brand}" catálogo OR catalog filetype:pdf`, 86);
    add('business', `"${brand}" products services`, 80);
  }
  for (const product of seeds.productNames.slice(0, 2)) {
    add('business', `"${product}" "${brand}"`, 70);
  }

  // History/news
  if (missing.has('history_news')) {
    add('news_history', `"${brand}" news OR noticias OR press`, 78);
    add('news_history', `"${brand}" founded OR history OR aniversario`, 74);
  }

  // Partners/relations
  if (missing.has('partners_clients')) {
    add('competitors', `"${brand}" distributor OR partner OR clientes`, 76);
  }

  // Optional packs (routed by source-router based on company type)
  if (plan.packs.includes('careers')) {
    add('business', `"${brand}" careers OR jobs OR hiring`, 60);
    add('business', `"${brand}" Glassdoor OR Indeed`, 55);
  }
  if (plan.packs.includes('reviews')) {
    add('business', `"${brand}" reviews OR Trustpilot OR Clutch OR G2 OR Crunchbase`, 62);
  }
  if (plan.packs.includes('apps')) {
    add('business', `"${brand}" site:play.google.com OR site:apps.apple.com`, 58);
  }
  if (plan.packs.includes('software')) {
    add('business', `"${brand}" GitHub OR npm OR SDK OR "API documentation"`, 58);
  }
  if (plan.packs.includes('ip')) {
    add('business', `"${brand}" patent OR trademark OR "Google Patents"`, 50);
  }
  if (plan.packs.includes('certifications')) {
    add('business', `"${brand}" ISO OR certification OR certificate filetype:pdf`, 64);
    for (const cert of seeds.certificationNames.slice(0, 2)) add('business', `"${brand}" "${cert}"`, 60);
  }

  return queries.sort((a, b) => b.priority - a.priority);
}
