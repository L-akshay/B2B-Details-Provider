import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * OpenAlex (free scholarly API, no key) — routed only for research/medical/AI
 * organizations. A matched institution gives homepage, country, and research
 * activity; evidence is marked as research signal, not commercial proof.
 */

interface OaInstitution {
  id?: string;
  display_name?: string;
  homepage_url?: string;
  country_code?: string;
  works_count?: number;
  type?: string;
}

export async function queryOpenAlex(companyName: string): Promise<{ evidence: EvidenceItem[]; errors: Record<string, string> }> {
  const evidence: EvidenceItem[] = [];
  const errors: Record<string, string> = {};
  try {
    const data = await withRetry(
      async (signal) => {
        const res = await fetch(
          `https://api.openalex.org/institutions?search=${encodeURIComponent(companyName)}&per-page=3`,
          { signal, headers: { 'User-Agent': 'company-research-tool/1.0 (mailto:research@example.com)' } },
        );
        if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
        return (await res.json()) as { results?: OaInstitution[] };
      },
      { service: 'openalex', timeoutMs: 15_000, retries: 1 },
    );

    const tokens = companyName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    const hit = (data.results ?? []).find((r) =>
      tokens.some((t) => (r.display_name ?? '').toLowerCase().includes(t)),
    );
    if (!hit?.id) return { evidence, errors };

    const srcUrl = hit.id;
    if (hit.works_count && hit.works_count > 0) {
      evidence.push(
        makeEvidence({
          field: 'history_event',
          value: `${hit.works_count} scholarly works associated on OpenAlex (research activity signal)`,
          sourceUrl: srcUrl,
          sourceTitle: `OpenAlex: ${hit.display_name}`,
          sourceType: 'openalex',
          extractedBy: 'api',
          confidence: 0.65,
          metadata: { researchSignal: true },
        }),
      );
    }
    if (hit.homepage_url) {
      evidence.push(
        makeEvidence({
          field: 'alternative_domain',
          value: hit.homepage_url,
          sourceUrl: srcUrl,
          sourceType: 'openalex',
          extractedBy: 'api',
          confidence: 0.6,
        }),
      );
    }
    if (hit.country_code) {
      evidence.push(
        makeEvidence({
          field: 'jurisdiction',
          value: hit.country_code,
          sourceUrl: srcUrl,
          sourceType: 'openalex',
          extractedBy: 'api',
          confidence: 0.6,
        }),
      );
    }
    logger.info({ institution: hit.display_name, evidence: evidence.length }, 'openalex complete');
  } catch (err) {
    errors['openalex'] = String(err);
  }
  return { evidence, errors };
}
