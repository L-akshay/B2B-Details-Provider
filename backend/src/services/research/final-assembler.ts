import type { CompanyReport, Confidence } from '../../types/schema';
import type { MergedEvidence } from './evidence-deduper';
import type { EvidenceField, EvidenceItem } from './types';

const NOT_AVAILABLE = 'Not publicly available';
const VERIFIED_THRESHOLD = 0.75;
const UNVERIFIED_THRESHOLD = 0.45;

type ReportWithEvidence = CompanyReport & {
  evidence_sources?: Record<string, string[]>;
  low_confidence_evidence?: Array<{
    field: EvidenceField;
    value: string;
    confidence: number;
    sourceUrls: string[];
  }>;
};

function emptyReport(companyName: string): ReportWithEvidence {
  return {
    company_name: companyName,
    description: '',
    legal_name: '',
    tax_id: '',
    addresses: [],
    phones: [],
    emails: [],
    website: '',
    linkedin_url: '',
    social_links: {
      facebook: '',
      instagram: '',
      twitter: '',
      youtube: '',
      tiktok: '',
      whatsapp: '',
    },
    industry: '',
    products_services: [],
    founded: '',
    employee_count: '',
    key_people: [],
    certifications: [],
    tech_stack: [],
    domain_registered: '',
    registrar: '',
    recent_news: [],
    overview: '',
    history: [],
    business_model: '',
    target_customers: '',
    markets_served: [],
    notable_clients_partners: [],
    competitors: [],
    suppliers: [],
    buyers: [],
    distributors: [],
    registration_id: '',
    legal_entity_id: '',
    jurisdiction: '',
    parent_company: '',
    funding_and_financials: '',
    awards: [],
    office_locations: [],
    not_found: [],
    evidence_sources: {},
    low_confidence_evidence: [],
  };
}

function sourceUrls(item: MergedEvidence | EvidenceItem): string[] {
  const maybeMerged = item as MergedEvidence;
  const urls = maybeMerged.sourceUrls?.length ? maybeMerged.sourceUrls : [item.sourceUrl];
  return [...new Set(urls.filter((url) => /^https?:\/\//.test(url) || url.startsWith('dns:')))];
}

function confidenceLabel(item: MergedEvidence): Confidence {
  return item.confidence >= 0.85 && item.verified !== 'low_confidence' ? 'high' : 'unverified';
}

function best(items: MergedEvidence[], field: EvidenceField): MergedEvidence | undefined {
  return items.find((item) => item.field === field && item.confidence >= VERIFIED_THRESHOLD);
}

function values(items: MergedEvidence[], field: EvidenceField, minConfidence = VERIFIED_THRESHOLD): MergedEvidence[] {
  return items.filter((item) => item.field === field && item.confidence >= minConfidence);
}

function setSources(report: ReportWithEvidence, field: string, items: Array<MergedEvidence | undefined>): void {
  const urls = items.flatMap((item) => (item ? sourceUrls(item) : []));
  if (urls.length > 0) report.evidence_sources![field] = [...new Set(urls)];
}

function addNotFound(report: ReportWithEvidence, fields: Array<[string, boolean]>): void {
  for (const [field, hasValue] of fields) {
    if (!hasValue) report.not_found.push(field);
  }
}

function maybeText(item: MergedEvidence | undefined): string {
  return item?.value?.trim() ?? '';
}

function itemDate(item: MergedEvidence): string {
  const date = item.metadata?.date;
  return typeof date === 'string' ? date : '';
}

/**
 * Builds the deterministic first draft directly from scored, deduped evidence.
 * AI reconciliation may add narrative fields later, but deterministic facts
 * should already be present here and must not be overwritten by "unknown".
 */
export function assembleDeterministicReport(
  companyName: string,
  evidence: MergedEvidence[],
): ReportWithEvidence {
  const report = emptyReport(companyName);

  const website = best(evidence, 'official_website');
  report.website = maybeText(website);
  setSources(report, 'website', [website]);

  const legalName = best(evidence, 'legal_name');
  report.legal_name = maybeText(legalName);
  setSources(report, 'legal_name', [legalName]);

  const description = best(evidence, 'description');
  report.description = maybeText(description);
  report.overview = report.description;
  setSources(report, 'description', [description]);

  const industry = best(evidence, 'industry');
  report.industry = maybeText(industry);
  setSources(report, 'industry', [industry]);

  const businessModel = best(evidence, 'business_model');
  report.business_model = maybeText(businessModel);
  setSources(report, 'business_model', [businessModel]);

  const targetCustomers = best(evidence, 'target_customers');
  report.target_customers = maybeText(targetCustomers);
  setSources(report, 'target_customers', [targetCustomers]);

  const founded = best(evidence, 'founding_year');
  report.founded = maybeText(founded);
  setSources(report, 'founded', [founded]);

  const employeeCount = best(evidence, 'employee_count');
  report.employee_count = maybeText(employeeCount);
  setSources(report, 'employee_count', [employeeCount]);

  const domainRegistered = best(evidence, 'domain_registered');
  report.domain_registered = maybeText(domainRegistered);
  setSources(report, 'domain_registered', [domainRegistered]);

  const registrar = best(evidence, 'registrar');
  report.registrar = maybeText(registrar);
  setSources(report, 'registrar', [registrar]);

  report.addresses = values(evidence, 'address').map((item) => ({
    value: item.value,
    source_url: sourceUrls(item)[0] ?? item.sourceUrl,
    confidence: confidenceLabel(item),
  }));
  setSources(report, 'addresses', values(evidence, 'address'));

  report.phones = values(evidence, 'phone').map((item) => ({
    value: item.value,
    source_url: sourceUrls(item)[0] ?? item.sourceUrl,
  }));
  setSources(report, 'phones', values(evidence, 'phone'));

  report.emails = values(evidence, 'email').map((item) => ({
    value: item.value.toLowerCase(),
    verified: item.confidence >= 0.85 && item.verified !== 'low_confidence',
    source: sourceUrls(item)[0] ?? item.sourceUrl,
  }));
  setSources(report, 'emails', values(evidence, 'email'));

  const linkedin = best(evidence, 'linkedin');
  report.linkedin_url = maybeText(linkedin);
  setSources(report, 'linkedin_url', [linkedin]);

  const socialMap: Array<[keyof ReportWithEvidence['social_links'], EvidenceField]> = [
    ['facebook', 'facebook'],
    ['instagram', 'instagram'],
    ['twitter', 'x_twitter'],
    ['youtube', 'youtube'],
    ['tiktok', 'tiktok'],
    ['whatsapp', 'whatsapp'],
  ];
  for (const [key, field] of socialMap) {
    const item = best(evidence, field);
    report.social_links[key] = maybeText(item);
    setSources(report, `social_links.${key}`, [item]);
  }

  report.products_services = values(evidence, 'products_services').map((item) => item.value);
  setSources(report, 'products_services', values(evidence, 'products_services'));

  report.certifications = values(evidence, 'certification').map((item) => item.value);
  setSources(report, 'certifications', values(evidence, 'certification'));

  report.tech_stack = values(evidence, 'tech_stack', 0.5).map((item) => item.value);
  setSources(report, 'tech_stack', values(evidence, 'tech_stack', 0.5));

  report.markets_served = values(evidence, 'market_served').map((item) => item.value);
  setSources(report, 'markets_served', values(evidence, 'market_served'));

  report.notable_clients_partners = values(evidence, 'client_partner').map((item) => item.value);
  setSources(report, 'notable_clients_partners', values(evidence, 'client_partner'));

  report.competitors = values(evidence, 'competitor', 0.55).map((item) => item.value);
  setSources(report, 'competitors', values(evidence, 'competitor', 0.55));

  report.suppliers = values(evidence, 'supplier', 0.5).map((item) => item.value);
  setSources(report, 'suppliers', values(evidence, 'supplier', 0.5));

  report.buyers = values(evidence, 'buyer', 0.5).map((item) => item.value);
  setSources(report, 'buyers', values(evidence, 'buyer', 0.5));

  report.distributors = values(evidence, 'distributor', 0.5).map((item) => item.value);
  setSources(report, 'distributors', values(evidence, 'distributor', 0.5));

  report.registration_id = maybeText(best(evidence, 'registration_id'));
  setSources(report, 'registration_id', [best(evidence, 'registration_id')]);

  report.jurisdiction = maybeText(best(evidence, 'jurisdiction'));
  setSources(report, 'jurisdiction', [best(evidence, 'jurisdiction')]);

  report.legal_entity_id = maybeText(best(evidence, 'legal_entity_id'));
  setSources(report, 'legal_entity_id', [best(evidence, 'legal_entity_id')]);

  report.parent_company = maybeText(best(evidence, 'parent_company'));
  setSources(report, 'parent_company', [best(evidence, 'parent_company')]);

  report.awards = values(evidence, 'award').map((item) => item.value);
  setSources(report, 'awards', values(evidence, 'award'));

  report.funding_and_financials = maybeText(best(evidence, 'funding_financials'));
  setSources(report, 'funding_and_financials', [best(evidence, 'funding_financials')]);

  report.key_people = values(evidence, 'key_person', 0.6).map((item) => {
    const profile = typeof item.metadata?.linkedinProfile === 'string' ? item.metadata.linkedinProfile : '';
    const src = sourceUrls(item)[0] ?? item.sourceUrl;
    return {
      name: item.value,
      role: typeof item.metadata?.role === 'string' ? item.metadata.role : '',
      source_url: src,
      linkedin: profile || (/linkedin\.com\/in\//i.test(src) ? src : ''),
    };
  });
  setSources(report, 'key_people', values(evidence, 'key_person', 0.6));

  report.history = values(evidence, 'history_event').map((item) => ({
    year: typeof item.metadata?.year === 'string' ? item.metadata.year : '',
    event: item.value,
  }));
  setSources(report, 'history', values(evidence, 'history_event'));

  report.recent_news = values(evidence, 'news', 0.55).map((item) => ({
    headline: item.value,
    url: sourceUrls(item)[0] ?? item.sourceUrl,
    date: itemDate(item),
  }));
  setSources(report, 'recent_news', values(evidence, 'news', 0.55));

  report.low_confidence_evidence = evidence
    .filter((item) => item.confidence >= UNVERIFIED_THRESHOLD && item.confidence < VERIFIED_THRESHOLD)
    .map((item) => ({
      field: item.field,
      value: item.value,
      confidence: item.confidence,
      sourceUrls: sourceUrls(item),
    }));

  addNotFound(report, [
    ['legal_name', Boolean(report.legal_name)],
    ['tax_id', Boolean(report.tax_id)],
    ['addresses', report.addresses.length > 0],
    ['phones', report.phones.length > 0],
    ['emails', report.emails.length > 0],
    ['website', Boolean(report.website)],
    ['linkedin_url', Boolean(report.linkedin_url)],
    ['industry', Boolean(report.industry)],
    ['products_services', report.products_services.length > 0],
    ['founded', Boolean(report.founded)],
    ['employee_count', Boolean(report.employee_count)],
    ['key_people', report.key_people.length > 0],
    ['certifications', report.certifications.length > 0],
    ['domain_registered', Boolean(report.domain_registered)],
    ['registrar', Boolean(report.registrar)],
    ['recent_news', report.recent_news.length > 0],
  ]);

  return report;
}

/**
 * Merges a future LLM reconciliation onto the deterministic draft. For now the
 * merge is intentionally defensive: only narrative/soft fields may be filled
 * from the LLM, and deterministic populated fields are preserved.
 */
export function assembleFinalReport(
  deterministic: ReportWithEvidence,
  llmOutput: Partial<CompanyReport> | null,
): ReportWithEvidence {
  if (!llmOutput) return deterministic;
  const out: ReportWithEvidence = { ...deterministic };
  // Narrative fields are the AI writer's job: it authors them in English from
  // the (possibly non-English) evidence, so its output WINS here. Contact/
  // domain/social facts are never in this list and stay untouched.
  const overwriteString = (key: keyof CompanyReport) => {
    const next = llmOutput[key];
    if (typeof next === 'string' && next.trim() && next !== NOT_AVAILABLE) {
      (out as unknown as Record<string, unknown>)[key] = next.trim();
    }
  };
  const fillArray = (key: keyof CompanyReport) => {
    const current = deterministic[key];
    const next = llmOutput[key];
    if (Array.isArray(current) && current.length === 0 && Array.isArray(next)) {
      (out as unknown as Record<string, unknown>)[key] = next;
    }
  };

  for (const key of ['overview', 'description', 'business_model', 'target_customers', 'industry'] as const) {
    overwriteString(key);
  }
  for (const key of [
    'products_services',
    'markets_served',
    'notable_clients_partners',
    'competitors',
    'suppliers',
    'buyers',
    'distributors',
    'awards',
    'office_locations',
    'history',
  ] as const) {
    fillArray(key);
  }

  // Recompute not_found AFTER the LLM merge so a field the AI just filled can
  // never appear in "Not publicly available" (acceptance criterion).
  out.not_found = out.not_found.filter((field) => {
    const v = (out as unknown as Record<string, unknown>)[field];
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return !v.trim() || v === NOT_AVAILABLE;
    return true;
  });

  return out;
}
