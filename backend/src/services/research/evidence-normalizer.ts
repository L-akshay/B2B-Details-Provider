import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { SOCIAL_FIELDS, type EvidenceField, type EvidenceItem } from './types';

const FIELD_ALIASES: Record<string, EvidenceField> = {
  legalName: 'legal_name',
  taxId: 'tax_id',
  registrationId: 'registration_id',
  website_url: 'official_website',
  website: 'official_website',
  linkedin_url: 'linkedin',
  instagram_url: 'instagram',
  facebook_url: 'facebook',
  youtube_url: 'youtube',
  twitter_url: 'x_twitter',
  employeeCount: 'employee_count',
  productsServices: 'products_services',
  domainRegistered: 'domain_registered',
  techStack: 'tech_stack',
  recentNews: 'news',
  keyPeople: 'key_person',
};

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    // strip tracking params
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^ref$|^source$/i.test(key)) url.searchParams.delete(key);
    }
    let out = url.toString().replace(/\/$/, '');
    out = out.replace(/^https?:\/\/www\./, 'https://');
    return out.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Assigns each evidence item a stable normalizedValue used for dedup and
 * multi-source agreement: emails lowercased, phones to E.164, URLs stripped
 * of tracking params, addresses/names collapsed.
 */
export function normalizeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return items.map((item) => {
    const field = FIELD_ALIASES[item.field] ?? item.field;
    item = field === item.field ? item : { ...item, field };
    if (item.normalizedValue) return item;
    let normalized = item.value.trim();

    if (item.field === 'email') {
      normalized = item.value.trim().toLowerCase();
    } else if (item.field === 'phone') {
      const parsed = parsePhoneNumberFromString(item.value, 'MX');
      normalized = parsed?.isValid() ? parsed.number : item.value.replace(/\D/g, '');
    } else if (
      SOCIAL_FIELDS.includes(item.field) ||
      item.field === 'official_website' ||
      item.field === 'pdf_document' ||
      item.field === 'contact_form' ||
      item.field === 'news'
    ) {
      normalized = normalizeUrl(item.value);
    } else if (item.field === 'address') {
      normalized = item.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    } else {
      normalized = item.value.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    return { ...item, normalizedValue: normalized };
  });
}
