import * as cheerio from 'cheerio';
import { makeEvidence, type CrawledPage, type EvidenceField, type EvidenceItem } from './types';

interface JsonLdOrg {
  '@type'?: string | string[];
  name?: string;
  legalName?: string;
  url?: string;
  logo?: string | { url?: string };
  description?: string;
  email?: string;
  telephone?: string;
  address?: unknown;
  sameAs?: string | string[];
  founder?: unknown;
  foundingDate?: string;
  areaServed?: unknown;
  contactPoint?: unknown;
}

const ORG_TYPES = /organization|localbusiness|medicalbusiness|corporation|store|company/i;

function flattenAddress(address: unknown): string | null {
  if (!address) return null;
  if (typeof address === 'string') return address;
  if (typeof address === 'object') {
    const a = address as Record<string, unknown>;
    const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
      .map((p) => (typeof p === 'string' ? p : null))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}

function personNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return (p as { name?: string }).name ?? null;
      return null;
    })
    .filter((n): n is string => Boolean(n));
}

const SAMEAS_FIELD: Array<[RegExp, EvidenceField]> = [
  [/linkedin\.com/i, 'linkedin'],
  [/instagram\.com/i, 'instagram'],
  [/facebook\.com/i, 'facebook'],
  [/youtube\.com/i, 'youtube'],
  [/(x|twitter)\.com/i, 'x_twitter'],
  [/tiktok\.com/i, 'tiktok'],
];

/**
 * Extracts titles, meta descriptions, OpenGraph and — most valuably —
 * schema.org Organization JSON-LD (legalName, email, telephone, address,
 * sameAs, founder, foundingDate) into evidence. Sites describe themselves
 * here far more reliably than any AI summary.
 */
export function extractMetadataAndSchema(pages: CrawledPage[]): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const push = (item: EvidenceItem) => {
    const key = `${item.field}:${item.value.toLowerCase().slice(0, 120)}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push(item);
  };

  for (const page of pages) {
    const base = {
      sourceUrl: page.finalUrl,
      sourceTitle: page.title,
      pageUrl: page.finalUrl,
      sourceType: 'official_website',
    } as const;

    const description = page.meta['description'] ?? page.meta['og:description'];
    if (description && description.length > 40 && (page.kind === 'home' || page.kind === 'about')) {
      push(
        makeEvidence({
          ...base,
          field: 'description',
          value: description.trim(),
          extractedBy: 'cheerio',
          confidence: 0.8,
          evidenceText: 'meta description',
        }),
      );
    }
    const siteName = page.meta['og:site_name'];
    if (siteName) {
      push(
        makeEvidence({
          ...base,
          field: 'brand_name',
          value: siteName.trim(),
          extractedBy: 'cheerio',
          confidence: 0.75,
          evidenceText: 'og:site_name',
        }),
      );
    }

    // schema.org JSON-LD
    const $ = cheerio.load(page.html);
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && '@graph' in (parsed as object)
          ? ((parsed as { '@graph': unknown[] })['@graph'] ?? [])
          : [parsed];

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const org = node as JsonLdOrg;
        const types = Array.isArray(org['@type']) ? org['@type'].join(' ') : (org['@type'] ?? '');
        if (!ORG_TYPES.test(types)) continue;

        const schemaBase = { ...base, extractedBy: 'cheerio' as const, evidenceText: `schema.org ${types}` };
        if (org.legalName) {
          push(makeEvidence({ ...schemaBase, field: 'legal_name', value: org.legalName, confidence: 0.9 }));
        }
        if (org.name) {
          push(makeEvidence({ ...schemaBase, field: 'brand_name', value: org.name, confidence: 0.85 }));
        }
        if (org.description && org.description.length > 40) {
          push(makeEvidence({ ...schemaBase, field: 'description', value: org.description, confidence: 0.85 }));
        }
        if (org.email) {
          push(
            makeEvidence({
              ...schemaBase,
              field: 'email',
              value: org.email.replace(/^mailto:/i, '').toLowerCase(),
              confidence: 0.9,
            }),
          );
        }
        if (org.telephone) {
          push(makeEvidence({ ...schemaBase, field: 'phone', value: String(org.telephone), confidence: 0.9 }));
        }
        const address = flattenAddress(org.address);
        if (address) {
          push(makeEvidence({ ...schemaBase, field: 'address', value: address, confidence: 0.9 }));
        }
        if (org.foundingDate) {
          push(
            makeEvidence({
              ...schemaBase,
              field: 'founding_year',
              value: String(org.foundingDate).slice(0, 4),
              confidence: 0.85,
            }),
          );
        }
        for (const founder of personNames(org.founder)) {
          push(
            makeEvidence({
              ...schemaBase,
              field: 'key_person',
              value: founder,
              confidence: 0.85,
              metadata: { role: 'Founder' },
            }),
          );
        }
        const sameAs = Array.isArray(org.sameAs) ? org.sameAs : org.sameAs ? [org.sameAs] : [];
        for (const url of sameAs) {
          const field = SAMEAS_FIELD.find(([re]) => re.test(url))?.[1] ?? 'other_social';
          push(
            makeEvidence({
              ...schemaBase,
              field,
              value: url,
              confidence: 0.95,
              evidenceText: 'schema.org sameAs',
            }),
          );
        }
        const served = Array.isArray(org.areaServed) ? org.areaServed : org.areaServed ? [org.areaServed] : [];
        for (const area of served) {
          const name = typeof area === 'string' ? area : ((area as { name?: string })?.name ?? null);
          if (name) push(makeEvidence({ ...schemaBase, field: 'market_served', value: name, confidence: 0.8 }));
        }
      }
    });
  }

  return evidence;
}
