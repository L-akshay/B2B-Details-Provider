import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * Free public Wikidata enrichment (no API key). Resolves the company entity
 * via wbsearchentities, then reads structured claims for legal identity and
 * business relationships. Every value carries the Wikidata entity URL as its
 * source. Returns [] on any miss — never throws into the pipeline.
 */

const API = 'https://www.wikidata.org/w/api.php';

interface Entity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value: unknown } } }>>;
}

async function wdFetch(params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ format: 'json', origin: '*', ...params }).toString();
  return withRetry(
    async (signal) => {
      const res = await fetch(`${API}?${qs}`, { signal, headers: { 'User-Agent': 'company-research-tool/1.0' } });
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      return res.json();
    },
    { service: 'wikidata', timeoutMs: 15_000, retries: 1 },
  );
}

/** Resolve claim values that are entity references (Q-ids) to their labels. */
async function labelsFor(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const data = (await wdFetch({
    action: 'wbgetentities',
    ids: ids.slice(0, 40).join('|'),
    props: 'labels',
    languages: 'en',
  })) as { entities?: Record<string, Entity> };
  const out: Record<string, string> = {};
  for (const [id, ent] of Object.entries(data.entities ?? {})) {
    const label = ent.labels?.en?.value;
    if (label) out[id] = label;
  }
  return out;
}

function claimStrings(entity: Entity, prop: string): string[] {
  return (entity.claims?.[prop] ?? [])
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v): v is string => typeof v === 'string');
}

function claimEntityIds(entity: Entity, prop: string): string[] {
  return (entity.claims?.[prop] ?? [])
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v): v is { id: string } => Boolean(v) && typeof v === 'object' && 'id' in (v as object))
    .map((v) => v.id);
}

function claimTime(entity: Entity, prop: string): { year: string; display: string } | undefined {
  const v = entity.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value as { time?: string } | undefined;
  const m = v?.time?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  // Wikidata uses 00 for unknown month/day — show only the parts we have
  const display = mo === '00' ? y! : d === '00' ? `${y}-${mo}` : `${y}-${mo}-${d}`;
  return { year: y!, display };
}

export async function queryWikidata(companyName: string): Promise<EvidenceItem[]> {
  try {
    const search = (await wdFetch({
      action: 'wbsearchentities',
      search: companyName,
      language: 'en',
      type: 'item',
      limit: '3',
    })) as { search?: Array<{ id: string; label?: string; description?: string }> };

    // Prefer a company/organization hit, but only accept it if its label
    // actually shares a brand token with the query — avoids attaching a
    // same-named-but-different Wikidata entity.
    const brandTokens = companyName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    const nameMatches = (label?: string) =>
      Boolean(label) && brandTokens.some((t) => label!.toLowerCase().includes(t));
    const hit =
      search.search?.find((s) => nameMatches(s.label) && /compan|corporation|business|manufacturer|enterprise|brand|firm|organization/i.test(s.description ?? '')) ??
      search.search?.find((s) => nameMatches(s.label));
    if (!hit) return [];

    const full = (await wdFetch({
      action: 'wbgetentities',
      ids: hit.id,
      props: 'labels|descriptions|claims',
      languages: 'en',
    })) as { entities?: Record<string, Entity> };
    const entity = full.entities?.[hit.id];
    if (!entity) return [];

    const src = `https://www.wikidata.org/wiki/${hit.id}`;
    const ev: EvidenceItem[] = [];
    // Cap per-field so entities like Apple (a website per country) don't flood.
    const fieldCounts: Partial<Record<string, number>> = {};
    const FIELD_CAP: Partial<Record<string, number>> = { official_website: 2, industry: 2, address: 2, jurisdiction: 2, key_person: 6, products_services: 8 };
    const push = (field: EvidenceItem['field'], value: string, confidence = 0.85, meta?: Record<string, unknown>) => {
      const cap = FIELD_CAP[field] ?? 4;
      const used = fieldCounts[field] ?? 0;
      if (value && value.trim() && used < cap) {
        fieldCounts[field] = used + 1;
        ev.push(
          makeEvidence({
            field,
            value: value.trim(),
            sourceUrl: src,
            sourceTitle: `Wikidata: ${hit.label ?? companyName}`,
            sourceType: 'wikidata',
            extractedBy: 'api',
            confidence,
            evidenceText: hit.description,
            metadata: meta,
          }),
        );
      }
    };

    // Direct value claims
    for (const site of claimStrings(entity, 'P856')) push('official_website', site, 0.8);
    const founded = claimTime(entity, 'P571');
    if (founded) {
      push('founding_year', founded.year, 0.85);
      push('history_event', `Founded (${founded.display})`, 0.8, { date: founded.display, derived: false });
    }
    for (const lei of claimStrings(entity, 'P1278')) push('legal_entity_id', lei, 0.9);

    // Entity-reference claims → resolve labels
    const refProps: Array<[string, EvidenceItem['field'], number]> = [
      ['P452', 'industry', 0.8], // industry
      ['P159', 'address', 0.75], // headquarters location
      ['P17', 'jurisdiction', 0.75], // country
      ['P112', 'key_person', 0.75], // founder
      ['P169', 'key_person', 0.8], // CEO
      ['P127', 'parent_company', 0.75], // owned by
      ['P749', 'parent_company', 0.8], // parent organization
      ['P1056', 'products_services', 0.7], // product or material produced
      ['P414', 'competitor', 0.4], // stock exchange (weak, skip mostly)
    ];
    const allIds = new Set<string>();
    for (const [prop] of refProps) claimEntityIds(entity, prop).forEach((id) => allIds.add(id));
    const labels = await labelsFor([...allIds]);

    for (const [prop, field, conf] of refProps) {
      if (prop === 'P414') continue; // skip stock-exchange as "competitor"
      for (const id of claimEntityIds(entity, prop)) {
        const label = labels[id];
        if (label) push(field, label, conf, prop === 'P169' || prop === 'P112' ? { role: prop === 'P169' ? 'CEO' : 'Founder' } : undefined);
      }
    }

    // English description as a low-weight description signal
    const desc = entity.descriptions?.en?.value;
    if (desc) push('description', desc, 0.6);

    logger.info({ entity: hit.id, evidence: ev.length }, 'wikidata enrichment complete');
    return ev;
  } catch (err) {
    logger.warn({ err: String(err) }, 'wikidata lookup failed');
    return [];
  }
}
