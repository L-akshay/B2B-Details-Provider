import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface WikidataFacts {
  entityId: string;
  label: string;
  description: string;
  website: string | null;
  founded: string | null;
  headquarters: string | null;
  country: string | null;
  industries: string[];
  ceo: string | null;
  founders: string[];
  legalForm: string | null;
  employees: string | null;
  linkedinUrl: string | null;
  twitter: string | null;
  facebook: string | null;
  instagram: string | null;
}

const API = 'https://www.wikidata.org/w/api.php';
const COMPANY_HINT_RE =
  /compan|corporat|business|enterprise|manufactur|startup|conglomerate|bank|airline|retailer|firm|provider|developer|producer|organi[sz]ation|brand|chain/i;

interface Claim {
  mainsnak?: {
    datavalue?: {
      value?: unknown;
    };
  };
}

async function wikidataGet(params: Record<string, string>): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ ...params, format: 'json', origin: '*' });
  return withRetry(
    async (signal) => {
      const response = await fetch(`${API}?${query}`, {
        signal,
        headers: { 'User-Agent': 'company-research-tool/1.0' },
      });
      if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    },
    { service: 'wikidata', timeoutMs: 15_000 },
  );
}

function claimString(claims: Record<string, Claim[]>, property: string): string | null {
  const value = claims[property]?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === 'string' ? value : null;
}

function claimEntityIds(claims: Record<string, Claim[]>, property: string, limit = 3): string[] {
  return (claims[property] ?? [])
    .slice(0, limit)
    .map((claim) => {
      const value = claim.mainsnak?.datavalue?.value as { id?: string } | undefined;
      return value?.id ?? null;
    })
    .filter((id): id is string => Boolean(id));
}

function claimTimeYear(claims: Record<string, Claim[]>, property: string): string | null {
  const value = claims[property]?.[0]?.mainsnak?.datavalue?.value as { time?: string } | undefined;
  const match = value?.time?.match(/([+-]?\d{4})/);
  return match?.[1]?.replace('+', '') ?? null;
}

function claimQuantity(claims: Record<string, Claim[]>, property: string): string | null {
  const value = claims[property]?.[0]?.mainsnak?.datavalue?.value as
    | { amount?: string }
    | undefined;
  return value?.amount?.replace('+', '') ?? null;
}

/**
 * Structured company facts from Wikidata (free, high precision for any
 * company notable enough to have an entry): founded, HQ, industry, CEO,
 * founders, legal form, official website, social handles.
 */
export async function wikidataLookup(companyName: string): Promise<ServiceResult<WikidataFacts>> {
  const sourceUrl = 'https://www.wikidata.org';
  try {
    const search = (await wikidataGet({
      action: 'wbsearchentities',
      search: companyName,
      language: 'en',
      type: 'item',
      limit: '5',
    })) as { search?: Array<{ id: string; label?: string; description?: string }> };

    const hits = search.search ?? [];
    if (hits.length === 0) throw new Error(`no Wikidata entity found for "${companyName}"`);
    const hit = hits.find((h) => COMPANY_HINT_RE.test(h.description ?? '')) ?? hits[0]!;

    const entityResponse = (await wikidataGet({
      action: 'wbgetentities',
      ids: hit.id,
      props: 'claims|labels|descriptions',
      languages: 'en',
    })) as {
      entities?: Record<string, { claims?: Record<string, Claim[]> }>;
    };
    const claims = entityResponse.entities?.[hit.id]?.claims ?? {};

    const hqIds = claimEntityIds(claims, 'P159', 1);
    const countryIds = claimEntityIds(claims, 'P17', 1);
    const industryIds = claimEntityIds(claims, 'P452', 3);
    const ceoIds = claimEntityIds(claims, 'P169', 1);
    const founderIds = claimEntityIds(claims, 'P112', 5);
    const legalFormIds = claimEntityIds(claims, 'P1454', 1);

    const referencedIds = [
      ...new Set([...hqIds, ...countryIds, ...industryIds, ...ceoIds, ...founderIds, ...legalFormIds]),
    ];
    const labels = new Map<string, string>();
    if (referencedIds.length > 0) {
      const labelResponse = (await wikidataGet({
        action: 'wbgetentities',
        ids: referencedIds.join('|'),
        props: 'labels',
        languages: 'en',
      })) as {
        entities?: Record<string, { labels?: { en?: { value?: string } } }>;
      };
      for (const [id, entity] of Object.entries(labelResponse.entities ?? {})) {
        const label = entity.labels?.en?.value;
        if (label) labels.set(id, label);
      }
    }
    const toLabel = (id: string | undefined): string | null => (id ? (labels.get(id) ?? null) : null);

    const linkedinSlug = claimString(claims, 'P4264');
    const twitterHandle = claimString(claims, 'P2002');
    const facebookId = claimString(claims, 'P2013');
    const instagramHandle = claimString(claims, 'P2003');

    return ok(
      {
        entityId: hit.id,
        label: hit.label ?? companyName,
        description: hit.description ?? '',
        website: claimString(claims, 'P856'),
        founded: claimTimeYear(claims, 'P571'),
        headquarters: toLabel(hqIds[0]),
        country: toLabel(countryIds[0]),
        industries: industryIds.map((id) => toLabel(id)).filter((l): l is string => Boolean(l)),
        ceo: toLabel(ceoIds[0]),
        founders: founderIds.map((id) => toLabel(id)).filter((l): l is string => Boolean(l)),
        legalForm: toLabel(legalFormIds[0]),
        employees: claimQuantity(claims, 'P1128'),
        linkedinUrl: linkedinSlug ? `https://www.linkedin.com/company/${linkedinSlug}` : null,
        twitter: twitterHandle ? `https://x.com/${twitterHandle}` : null,
        facebook: facebookId ? `https://www.facebook.com/${facebookId}` : null,
        instagram: instagramHandle ? `https://www.instagram.com/${instagramHandle}` : null,
      },
      `https://www.wikidata.org/wiki/${hit.id}`,
    );
  } catch (err) {
    return fail('wikidata', sourceUrl, err);
  }
}
