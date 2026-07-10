export type Confidence = 'high' | 'unverified';

export interface SourcedValue {
  value: string;
  source_url: string;
  confidence: Confidence;
}

export interface PhoneRecord {
  value: string;
  source_url: string;
}

export interface EmailRecord {
  value: string;
  verified: boolean;
  source: string;
}

export interface SocialLinks {
  facebook: string;
  instagram: string;
  twitter: string;
  youtube: string;
  tiktok: string;
  whatsapp: string;
}

export interface KeyPerson {
  name: string;
  role: string;
  source_url: string;
  /** Public LinkedIn profile URL, when found via public search */
  linkedin?: string;
}

export interface NewsItem {
  headline: string;
  url: string;
  date: string;
}

export interface HistoryEvent {
  year: string;
  event: string;
}

export interface CompanyReport {
  company_name: string;
  description: string;
  legal_name: string;
  tax_id: string;
  addresses: SourcedValue[];
  phones: PhoneRecord[];
  emails: EmailRecord[];
  website: string;
  linkedin_url: string;
  social_links: SocialLinks;
  industry: string;
  products_services: string[];
  founded: string;
  employee_count: string;
  key_people: KeyPerson[];
  certifications: string[];
  tech_stack: string[];
  domain_registered: string;
  registrar: string;
  recent_news: NewsItem[];
  /** Deep-detail profile — primarily researched by the search-grounded pass */
  overview: string;
  history: HistoryEvent[];
  business_model: string;
  target_customers: string;
  markets_served: string[];
  notable_clients_partners: string[];
  competitors: string[];
  /** B2B relationship intelligence (lead-enrichment) */
  suppliers: string[];
  buyers: string[];
  distributors: string[];
  /** Legal-registry identity from free public databases (Wikidata/GLEIF) */
  registration_id: string;
  legal_entity_id: string;
  jurisdiction: string;
  parent_company: string;
  funding_and_financials: string;
  awards: string[];
  office_locations: string[];
  not_found: string[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ResearchJob {
  id: string;
  company_name: string;
  extra_info: string | null;
  status: JobStatus;
  result_json: CompanyReport | null;
  docx_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * JSON Schema mirror of CompanyReport, passed to the model calls that support
 * strict structured output (Groq JSON schema mode, Gemini responseSchema).
 */
export const companyReportJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'company_name',
    'description',
    'legal_name',
    'tax_id',
    'addresses',
    'phones',
    'emails',
    'website',
    'linkedin_url',
    'social_links',
    'industry',
    'products_services',
    'founded',
    'employee_count',
    'key_people',
    'certifications',
    'tech_stack',
    'domain_registered',
    'registrar',
    'recent_news',
    'overview',
    'history',
    'business_model',
    'target_customers',
    'markets_served',
    'notable_clients_partners',
    'competitors',
    'funding_and_financials',
    'awards',
    'office_locations',
    'not_found',
  ],
  properties: {
    company_name: { type: 'string' },
    description: { type: 'string' },
    legal_name: { type: 'string' },
    tax_id: { type: 'string' },
    addresses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'source_url', 'confidence'],
        properties: {
          value: { type: 'string' },
          source_url: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'unverified'] },
        },
      },
    },
    phones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'source_url'],
        properties: {
          value: { type: 'string' },
          source_url: { type: 'string' },
        },
      },
    },
    emails: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'verified', 'source'],
        properties: {
          value: { type: 'string' },
          verified: { type: 'boolean' },
          source: { type: 'string' },
        },
      },
    },
    website: { type: 'string' },
    linkedin_url: { type: 'string' },
    social_links: {
      type: 'object',
      additionalProperties: false,
      required: ['facebook', 'instagram', 'twitter', 'youtube', 'tiktok', 'whatsapp'],
      properties: {
        facebook: { type: 'string' },
        instagram: { type: 'string' },
        twitter: { type: 'string' },
        youtube: { type: 'string' },
        tiktok: { type: 'string' },
        whatsapp: { type: 'string' },
      },
    },
    industry: { type: 'string' },
    products_services: { type: 'array', items: { type: 'string' } },
    founded: { type: 'string' },
    employee_count: { type: 'string' },
    key_people: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'source_url'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          source_url: { type: 'string' },
        },
      },
    },
    certifications: { type: 'array', items: { type: 'string' } },
    tech_stack: { type: 'array', items: { type: 'string' } },
    domain_registered: { type: 'string' },
    registrar: { type: 'string' },
    recent_news: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'url', 'date'],
        properties: {
          headline: { type: 'string' },
          url: { type: 'string' },
          date: { type: 'string' },
        },
      },
    },
    overview: { type: 'string' },
    history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['year', 'event'],
        properties: {
          year: { type: 'string' },
          event: { type: 'string' },
        },
      },
    },
    business_model: { type: 'string' },
    target_customers: { type: 'string' },
    markets_served: { type: 'array', items: { type: 'string' } },
    notable_clients_partners: { type: 'array', items: { type: 'string' } },
    competitors: { type: 'array', items: { type: 'string' } },
    funding_and_financials: { type: 'string' },
    awards: { type: 'array', items: { type: 'string' } },
    office_locations: { type: 'array', items: { type: 'string' } },
    not_found: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * Standard result envelope every data-collection service returns.
 * Source attribution is mandatory — downstream reconciliation depends on it.
 */
export interface ServiceResult<T> {
  data: T | null;
  sourceUrl: string;
  success: boolean;
  error: string | null;
}
