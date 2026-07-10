import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * Free GLEIF LEI database enrichment (no API key). Fuzzy-searches legal
 * entities by name and, on a confident match, emits the LEI, official legal
 * name, registered address, jurisdiction, legal form, and entity status —
 * high-value for B2B supplier/buyer verification. Returns [] on any miss.
 */

const API = 'https://api.gleif.org/api/v1/lei-records';

interface LeiRecord {
  id: string;
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      legalAddress?: {
        addressLines?: string[];
        city?: string;
        region?: string;
        country?: string;
        postalCode?: string;
      };
      jurisdiction?: string;
      legalForm?: { id?: string };
      status?: string;
    };
    registration?: { status?: string; managingLou?: string };
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(s\.?a\.?(\s+de\s+c\.?v\.?)?|inc|llc|ltd|corp|gmbh|co|sa|srl|bv|plc)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export async function queryGleif(companyName: string): Promise<EvidenceItem[]> {
  try {
    // fulltext fuzzy-matches across entity fields (exact legalName rarely hits)
    const url = `${API}?filter[fulltext]=${encodeURIComponent(companyName)}&page[size]=8`;
    const data = await withRetry(
      async (signal) => {
        const res = await fetch(url, { signal, headers: { Accept: 'application/vnd.api+json' } });
        if (!res.ok) throw new Error(`GLEIF HTTP ${res.status}`);
        return (await res.json()) as { data?: LeiRecord[] };
      },
      { service: 'gleif', timeoutMs: 15_000, retries: 1 },
    );

    const records = data.data ?? [];
    if (records.length === 0) return [];

    // Require a STRONG name match (full containment either direction). A mere
    // shared prefix is not enough: same-named entities exist across countries
    // (e.g. a Portuguese "BIOADVANCE ... LDA" vs a Mexican medical firm), and
    // attaching the wrong LEI/legal name is worse than returning nothing.
    const target = normalize(companyName);
    const scored = records
      .map((r) => {
        const name = r.attributes?.entity?.legalName?.name ?? '';
        const n = normalize(name);
        const strong = Boolean(n && target && n.length >= 5 && (n.includes(target) || target.includes(n)));
        return { r, strong, name };
      })
      .filter((s) => s.strong);

    const best = scored[0];
    if (!best) return [];

    const rec = best.r;
    const attr = rec.attributes;
    const entity = attr?.entity;
    const lei = attr?.lei ?? rec.id;
    const src = `https://search.gleif.org/#/record/${lei}`;
    const ev: EvidenceItem[] = [];
    const push = (field: EvidenceItem['field'], value?: string, confidence = 0.9) => {
      if (value && value.trim()) {
        ev.push(
          makeEvidence({
            field,
            value: value.trim(),
            sourceUrl: src,
            sourceTitle: `GLEIF LEI record: ${best.name}`,
            sourceType: 'gleif',
            extractedBy: 'api',
            confidence,
            evidenceText: `GLEIF-registered entity, status ${entity?.status ?? 'unknown'}`,
          }),
        );
      }
    };

    push('legal_entity_id', lei, 0.95);
    push('legal_name', entity?.legalName?.name, 0.9);
    push('jurisdiction', entity?.jurisdiction, 0.9);

    const addr = entity?.legalAddress;
    if (addr) {
      const parts = [...(addr.addressLines ?? []), addr.city, addr.region, addr.postalCode, addr.country].filter(Boolean);
      if (parts.length >= 2) push('address', parts.join(', '), 0.85);
    }

    logger.info({ lei, evidence: ev.length }, 'gleif enrichment complete');
    return ev;
  } catch (err) {
    logger.warn({ err: String(err) }, 'gleif lookup failed');
    return [];
  }
}
