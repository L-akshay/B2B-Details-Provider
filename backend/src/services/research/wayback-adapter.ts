import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * Internet Archive CDX lookups (free, public). Yields the domain's first-seen
 * year (history signal independent of RDAP) and pointers to archived
 * about/contact snapshots. Everything is marked archived: capped confidence,
 * never presented as current fact.
 */

const CDX = 'https://web.archive.org/cdx/search/cdx';

async function cdx(params: string): Promise<string[][]> {
  return withRetry(
    async (signal) => {
      const res = await fetch(`${CDX}?${params}`, {
        signal,
        headers: { 'User-Agent': 'company-research-tool/1.0 (public research)' },
      });
      if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);
      const json = (await res.json()) as string[][];
      return Array.isArray(json) ? json.slice(1) : []; // row 0 is the header
    },
    { service: 'wayback-cdx', timeoutMs: 20_000, retries: 1 },
  );
}

export async function queryWayback(domain: string): Promise<{ evidence: EvidenceItem[]; errors: Record<string, string> }> {
  const evidence: EvidenceItem[] = [];
  const errors: Record<string, string> = {};

  // First snapshot → "website online since" (derived, archived)
  try {
    const rows = await cdx(`url=${domain}&output=json&fl=timestamp&filter=statuscode:200&limit=1`);
    const ts = rows[0]?.[0];
    if (ts && ts.length >= 4) {
      const year = ts.slice(0, 4);
      const snapshotUrl = `https://web.archive.org/web/${ts}/${domain}`;
      evidence.push(
        makeEvidence({
          field: 'history_event',
          value: `Website first archived by the Internet Archive (${year})`,
          sourceUrl: snapshotUrl,
          sourceType: 'wayback',
          extractedBy: 'api',
          confidence: 0.6,
          evidenceText: `earliest snapshot ${ts.slice(0, 8)}`,
          metadata: { archived: true, derived: true, date: year },
          domain,
        }),
      );
    }
  } catch (err) {
    errors['wayback-first'] = String(err);
  }

  // Archived about/contact snapshots → useful when the live site is thin
  try {
    const rows = await cdx(
      `url=${domain}/*&output=json&fl=timestamp,original&filter=statuscode:200&collapse=urlkey&limit=40`,
    );
    let added = 0;
    for (const [ts, original] of rows) {
      if (!ts || !original) continue;
      if (!/contact|about|nosotros|contacto|quienes|historia/i.test(original)) continue;
      evidence.push(
        makeEvidence({
          field: 'source_url',
          value: `https://web.archive.org/web/${ts}/${original}`,
          sourceUrl: `https://web.archive.org/web/${ts}/${original}`,
          sourceTitle: `Archived: ${original}`,
          sourceType: 'wayback',
          extractedBy: 'api',
          confidence: 0.5,
          evidenceText: `archived ${ts.slice(0, 8)}`,
          metadata: { archived: true },
          domain,
        }),
      );
      added += 1;
      if (added >= 5) break;
    }
  } catch (err) {
    errors['wayback-pages'] = String(err);
  }

  logger.info({ domain, evidence: evidence.length }, 'wayback lookup complete');
  return { evidence, errors };
}
