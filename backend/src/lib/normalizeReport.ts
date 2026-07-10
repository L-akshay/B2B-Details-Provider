import type {
  CompanyReport,
  Confidence,
  EmailRecord,
  HistoryEvent,
  KeyPerson,
  NewsItem,
  PhoneRecord,
  SourcedValue,
} from '../types/schema';

function toStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toStrArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(toStr).filter(Boolean);
  const single = toStr(value).trim();
  return single && single.toLowerCase() !== 'not publicly available' ? [single] : [];
}

function toRecords<T>(value: unknown, map: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' ? map(item as Record<string, unknown>) : null))
    .filter((item): item is T => item !== null);
}

/**
 * Coerces model output into the exact CompanyReport shape. Models running in
 * json_object mode (no schema enforcement) occasionally emit "" where an
 * array belongs or drop keys entirely; everything downstream (DOCX, frontend,
 * stored result_json) assumes the schema, so normalize once at the source.
 */
export function normalizeReport(raw: unknown): CompanyReport {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const socials = (r.social_links && typeof r.social_links === 'object' ? r.social_links : {}) as Record<string, unknown>;

  return {
    company_name: toStr(r.company_name),
    description: toStr(r.description),
    legal_name: toStr(r.legal_name),
    tax_id: toStr(r.tax_id),
    addresses: toRecords<SourcedValue>(r.addresses, (a) =>
      toStr(a.value)
        ? {
            value: toStr(a.value),
            source_url: toStr(a.source_url),
            confidence: (a.confidence === 'unverified' ? 'unverified' : 'high') as Confidence,
          }
        : null,
    ),
    phones: toRecords<PhoneRecord>(r.phones, (p) =>
      toStr(p.value) ? { value: toStr(p.value), source_url: toStr(p.source_url) } : null,
    ),
    emails: toRecords<EmailRecord>(r.emails, (e) =>
      toStr(e.value)
        ? { value: toStr(e.value), verified: e.verified === true, source: toStr(e.source) }
        : null,
    ),
    website: toStr(r.website),
    linkedin_url: toStr(r.linkedin_url),
    social_links: {
      facebook: toStr(socials.facebook),
      instagram: toStr(socials.instagram),
      twitter: toStr(socials.twitter),
      youtube: toStr(socials.youtube),
      tiktok: toStr(socials.tiktok),
      whatsapp: toStr(socials.whatsapp),
    },
    industry: toStr(r.industry),
    products_services: toStrArray(r.products_services),
    founded: toStr(r.founded),
    employee_count: toStr(r.employee_count),
    key_people: toRecords<KeyPerson>(r.key_people, (k) =>
      toStr(k.name)
        ? { name: toStr(k.name), role: toStr(k.role), source_url: toStr(k.source_url) }
        : null,
    ),
    certifications: toStrArray(r.certifications),
    tech_stack: toStrArray(r.tech_stack),
    domain_registered: toStr(r.domain_registered),
    registrar: toStr(r.registrar),
    recent_news: toRecords<NewsItem>(r.recent_news, (n) =>
      toStr(n.headline)
        ? { headline: toStr(n.headline), url: toStr(n.url), date: toStr(n.date) }
        : null,
    ),
    overview: toStr(r.overview),
    history: toRecords<HistoryEvent>(r.history, (h) =>
      toStr(h.event) ? { year: toStr(h.year), event: toStr(h.event) } : null,
    ),
    business_model: toStr(r.business_model),
    target_customers: toStr(r.target_customers),
    markets_served: toStrArray(r.markets_served),
    notable_clients_partners: toStrArray(r.notable_clients_partners),
    competitors: toStrArray(r.competitors),
    suppliers: toStrArray(r.suppliers),
    buyers: toStrArray(r.buyers),
    distributors: toStrArray(r.distributors),
    registration_id: toStr(r.registration_id),
    legal_entity_id: toStr(r.legal_entity_id),
    jurisdiction: toStr(r.jurisdiction),
    parent_company: toStr(r.parent_company),
    funding_and_financials: toStr(r.funding_and_financials),
    awards: toStrArray(r.awards),
    office_locations: toStrArray(r.office_locations),
    not_found: toStrArray(r.not_found),
  };
}
