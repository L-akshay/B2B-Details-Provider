import { logger } from '../../lib/logger';
import { simplifyCompanyName } from '../../lib/companyName';
import { withRetry } from '../../lib/retry';
import { publicFetch } from './public-fetch';
import { makeEvidence, type EvidenceItem } from './types';

export interface CandidateScore {
  domain: string;
  confidence: number;
  reasons: string[];
  sourceUrl?: string;
}

export interface DomainResolution {
  selectedDomain: string | null;
  confidence: number;
  status: 'verified' | 'found_unverified' | 'not_found';
  alternativeDomains: string[];
  reasoning: string[];
  candidates: CandidateScore[];
  evidence: EvidenceItem[];
}

const BLOCKED_AS_OFFICIAL =
  /linkedin|facebook|instagram|youtube|twitter|x\.com|tiktok|wikipedia|wikidata|crunchbase|zoominfo|dnb\.com|glassdoor|indeed|yelp|google\.|gleif|opencorporates|amazon\.|mercadolibre|blogspot|wordpress\.com|wixsite|github\.io/i;

const PARKED_SIGNALS =
  /domain (is )?for sale|buy this domain|parked free|godaddy\.com\/park|sedoparking|this domain may be for sale|hugedomains/i;

interface Prior {
  domain: string;
  points: number;
  reason: string;
}

function nameTokens(companyName: string): string[] {
  return simplifyCompanyName(companyName)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

async function probeHomepage(
  domain: string,
): Promise<{ ok: boolean; title: string; bodySample: string; parked: boolean }> {
  try {
    return await withRetry(
      async (signal) => {
        const response = await publicFetch(`https://${domain}`, { signal, redirect: 'follow' });
        const html = (await response.text()).slice(0, 60_000);
        const title = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim() ?? '';
        return {
          ok: response.ok,
          title,
          bodySample: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3_000),
          parked: PARKED_SIGNALS.test(html),
        };
      },
      { service: 'domain-probe', timeoutMs: 12_000, retries: 0 },
    );
  } catch {
    return { ok: false, title: '', bodySample: '', parked: false };
  }
}

/**
 * Scores candidate domains per the evidence-first rulebook and probes the
 * top candidates' homepages before selecting. Never selects a social or
 * directory domain as the official website.
 */
export async function resolveOfficialDomain(
  companyName: string,
  serpEvidence: EvidenceItem[],
  priors: Prior[] = [],
): Promise<DomainResolution> {
  const tokens = nameTokens(companyName);
  const scores = new Map<string, CandidateScore>();

  const bump = (domain: string, points: number, reason: string, sourceUrl?: string) => {
    if (!domain || BLOCKED_AS_OFFICIAL.test(domain)) return;
    const existing = scores.get(domain) ?? { domain, confidence: 0, reasons: [], sourceUrl };
    existing.confidence += points;
    existing.reasons.push(reason);
    if (sourceUrl && !existing.sourceUrl) existing.sourceUrl = sourceUrl;
    scores.set(domain, existing);
  };

  for (const prior of priors) {
    bump(prior.domain, prior.points, prior.reason);
  }

  for (const item of serpEvidence) {
    if (item.field !== 'alternative_domain' || !item.domain) continue;
    const rank = Number(item.metadata?.rank ?? 10);
    bump(item.domain, rank <= 3 ? 10 : 4, `search result rank ${rank} for "${item.query}"`, item.sourceUrl);
    const haystack = `${item.sourceTitle ?? ''} ${item.evidenceText ?? ''}`.toLowerCase();
    const titleHits = tokens.filter((t) => haystack.includes(t)).length;
    if (tokens.length > 0 && titleHits >= Math.min(2, tokens.length)) {
      bump(item.domain, 20, 'company name matches result title/snippet');
    }
    const bare = item.domain.replace(/\.(com|mx|net|org|io|co|lat|info|biz)(\.[a-z]{2})?$/i, '');
    if (tokens.some((t) => bare.includes(t))) {
      bump(item.domain, 25, 'brand token appears in domain');
    }
  }

  // Probe up to 3 leading candidates for real content / parked pages
  const ranked = [...scores.values()].sort((a, b) => b.confidence - a.confidence);
  for (const candidate of ranked.slice(0, 3)) {
    const probe = await probeHomepage(candidate.domain);
    if (probe.parked) {
      candidate.confidence -= 40;
      candidate.reasons.push('parked/for-sale page detected');
      continue;
    }
    if (probe.ok && probe.bodySample.length > 400) {
      candidate.confidence += 10;
      candidate.reasons.push('domain serves real content');
    }
    const titleAndBody = `${probe.title} ${probe.bodySample}`.toLowerCase();
    const hits = tokens.filter((t) => titleAndBody.includes(t)).length;
    if (tokens.length > 0 && hits >= Math.min(2, tokens.length)) {
      candidate.confidence += 20;
      candidate.reasons.push('company name found on homepage');
    } else if (probe.ok && hits === 0 && tokens.length >= 2) {
      candidate.confidence -= 30;
      candidate.reasons.push('homepage content does not mention the company');
    }
  }

  const final = [...scores.values()]
    .map((c) => ({ ...c, confidence: Math.max(0, Math.min(1, c.confidence / 100)) }))
    .sort((a, b) => b.confidence - a.confidence);

  const best = final[0];
  const selected = best && best.confidence >= 0.6 ? best : null;
  const status: DomainResolution['status'] = !selected
    ? 'not_found'
    : selected.confidence >= 0.85
      ? 'verified'
      : 'found_unverified';

  const alternativeDomains = final
    .slice(1, 4)
    .filter((c) => c.confidence >= 0.3)
    .map((c) => c.domain);

  const evidence: EvidenceItem[] = [];
  if (selected) {
    evidence.push(
      makeEvidence({
        field: 'official_website',
        value: `https://${selected.domain}`,
        sourceUrl: selected.sourceUrl ?? `https://${selected.domain}`,
        sourceType: 'search_result',
        extractedBy: 'serp',
        confidence: selected.confidence,
        domain: selected.domain,
        evidenceText: selected.reasons.join('; '),
      }),
    );
    for (const alt of alternativeDomains) {
      evidence.push(
        makeEvidence({
          field: 'alternative_domain',
          value: alt,
          sourceUrl: `https://${alt}`,
          sourceType: 'search_result',
          extractedBy: 'serp',
          confidence: 0.5,
          domain: alt,
        }),
      );
    }
  }

  logger.info(
    { selected: selected?.domain ?? null, confidence: best?.confidence ?? 0, status },
    'official domain resolution',
  );

  return {
    selectedDomain: selected?.domain ?? null,
    confidence: selected?.confidence ?? (best?.confidence ?? 0),
    status,
    alternativeDomains,
    reasoning: selected?.reasons ?? best?.reasons ?? ['no candidate domains found'],
    candidates: final.slice(0, 8),
    evidence,
  };
}
