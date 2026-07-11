export type EvidenceField =
  | 'official_website'
  | 'alternative_domain'
  | 'legal_name'
  | 'tax_id'
  | 'registration_id'
  | 'legal_entity_id'
  | 'jurisdiction'
  | 'parent_company'
  | 'brand_name'
  | 'description'
  | 'industry'
  | 'business_model'
  | 'target_customers'
  | 'products_services'
  | 'email'
  | 'phone'
  | 'whatsapp'
  | 'address'
  | 'contact_form'
  | 'linkedin'
  | 'instagram'
  | 'facebook'
  | 'youtube'
  | 'x_twitter'
  | 'tiktok'
  | 'other_social'
  | 'founding_year'
  | 'history_event'
  | 'key_person'
  | 'employee_count'
  | 'certification'
  | 'award'
  | 'client_partner'
  | 'supplier'
  | 'buyer'
  | 'distributor'
  | 'market_served'
  | 'competitor'
  | 'news'
  | 'pdf_document'
  | 'tech_stack'
  | 'domain_registered'
  | 'registrar'
  | 'dns'
  | 'mx_provider'
  | 'spf'
  | 'dmarc'
  | 'funding_financials'
  | 'source_url'
  | 'unknown';

export type SourceType =
  | 'official_website'
  | 'official_pdf'
  | 'search_result'
  | 'news'
  | 'social'
  | 'rdap'
  | 'dns'
  | 'wikidata'
  | 'gleif'
  | 'firecrawl'
  | 'llm'
  | 'third_party_directory'
  | 'public_registry'
  | 'wayback'
  | 'openalex'
  | 'sec_edgar'
  | 'manual_fallback';

export type ExtractedBy =
  | 'regex'
  | 'cheerio'
  | 'playwright'
  | 'sitemap'
  | 'robots'
  | 'api'
  | 'rdap'
  | 'dns'
  | 'llm'
  | 'serp'
  | 'pdf_parser'
  | 'tech_fingerprint';

export type VerificationStatus =
  | 'source_verified'
  | 'multi_source_verified'
  | 'unverified'
  | 'conflicting'
  | 'low_confidence';

export type EvidenceItem = {
  id: string;
  field: EvidenceField;
  value: string;
  normalizedValue?: string;
  sourceUrl: string;
  sourceTitle?: string;
  sourceType: SourceType;
  evidenceText?: string;
  extractedBy: ExtractedBy;
  confidence: number;
  verified: VerificationStatus;
  retrievedAt: string;
  query?: string;
  pageUrl?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
};

export type ResearchDebug = {
  companyInput: string;
  startedAt: string;
  finishedAt?: string;
  generatedQueriesCount: number;
  searchResultsCount: number;
  serpEvidenceCount: number;
  selectedDomain?: string;
  selectedDomainConfidence?: number;
  candidateDomains: Array<{
    domain: string;
    confidence: number;
    reasons: string[];
    sourceUrl?: string;
  }>;
  searchQueriesRun: string[];
  topResultsByQuery: Record<
    string,
    Array<{
      title: string;
      url: string;
      snippet?: string;
    }>
  >;
  crawledUrls: Array<{
    url: string;
    status: number;
    source: 'custom_crawler' | 'firecrawl' | 'playwright';
    contentLength?: number;
    error?: string;
  }>;
  servicesCalled: Record<string, 'success' | 'failed' | 'skipped'>;
  serviceErrors: Record<string, string>;
  evidenceCountByField: Record<string, number>;
  extractedBeforeAI: {
    emails: EvidenceItem[];
    phones: EvidenceItem[];
    addresses: EvidenceItem[];
    socials: EvidenceItem[];
    techStack: EvidenceItem[];
    domains: EvidenceItem[];
    people: EvidenceItem[];
    productsServices: EvidenceItem[];
    news: EvidenceItem[];
  };
  llmInputEvidenceCount: number;
  llmOutput?: unknown;
  deterministicOverridesApplied: string[];
  finalFieldSources: Record<string, string[]>;
  fieldsFilteredDueToConfidence: string[];
  fieldsIgnoredDueToSchemaMismatch: string[];
  warnings: string[];
  /** Recursive-discovery telemetry (round 2+, coverage, source routing). */
  coverageScore?: number;
  missingCriticalFields?: string[];
  recommendedNextActions?: string[];
  discoveryRounds?: Array<{
    round: number;
    queriesRun: string[];
    searchResults: number;
    evidenceFound: number;
    newSeeds?: Record<string, string[]>;
  }>;
  sourceRouter?: {
    sourcesSelected: Array<{ source: string; reason: string }>;
    sourcesSkipped: Array<{ source: string; reason: string }>;
  };
  moduleCounts?: Record<string, number>;
};

/** A single search engine result, provider-agnostic. */
export type SerpResult = {
  query: string;
  intent: string;
  title: string;
  url: string;
  snippet?: string;
  rank: number;
  provider: string;
};

/** Normalized crawled page shared by every extractor. */
export type CrawledPage = {
  url: string;
  status: number;
  finalUrl: string;
  title: string;
  html: string;
  text: string;
  links: string[];
  meta: Record<string, string>;
  headers: Record<string, string>;
  source: 'custom_crawler' | 'firecrawl' | 'playwright';
  fetchedAt: string;
  /** Rough page kind used by scorers (contact page beats blog post) */
  kind: 'home' | 'contact' | 'about' | 'legal' | 'team' | 'products' | 'news' | 'other';
};

let evidenceCounter = 0;

export function makeEvidence(
  partial: Omit<EvidenceItem, 'id' | 'retrievedAt' | 'verified'> &
    Partial<Pick<EvidenceItem, 'verified'>>,
): EvidenceItem {
  evidenceCounter += 1;
  return {
    verified: 'unverified',
    ...partial,
    id: `ev-${partial.field}-${evidenceCounter}`,
    retrievedAt: new Date().toISOString(),
  };
}

export const SOCIAL_FIELDS: EvidenceField[] = [
  'linkedin',
  'instagram',
  'facebook',
  'youtube',
  'x_twitter',
  'tiktok',
  'whatsapp',
];

/** Fields where deterministic evidence is authoritative — AI can never overwrite. */
export const DETERMINISTIC_FIELDS: EvidenceField[] = [
  'official_website',
  'alternative_domain',
  'email',
  'phone',
  'whatsapp',
  'address',
  'contact_form',
  ...SOCIAL_FIELDS,
  'domain_registered',
  'registrar',
  'dns',
  'mx_provider',
  'spf',
  'dmarc',
  'tech_stack',
  'pdf_document',
];
