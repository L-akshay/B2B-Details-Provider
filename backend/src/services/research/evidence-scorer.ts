import type { EvidenceItem, SourceType, VerificationStatus } from './types';

/**
 * Baseline confidence floors by source type. An item's own extractor
 * confidence is kept if higher — these enforce a minimum trustworthiness by
 * provenance so a snippet can't out-rank an official contact page.
 */
const SOURCE_FLOOR: Record<SourceType, number> = {
  official_website: 0.9,
  official_pdf: 0.85,
  rdap: 0.9,
  dns: 0.9,
  wikidata: 0.85,
  gleif: 0.9,
  news: 0.75,
  social: 0.75,
  search_result: 0.55,
  third_party_directory: 0.5,
  public_registry: 0.9,
  firecrawl: 0.85,
  llm: 0.4,
  manual_fallback: 0.3,
};

const LLM_CAP = 0.4;

/**
 * Applies source-type-aware scoring and caps. LLM-sourced evidence is capped
 * at 0.4; derived facts stay low. This runs before dedup so multi-source
 * agreement can boost from a correct baseline.
 */
export function scoreEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return items.map((item) => {
    const floor = SOURCE_FLOOR[item.sourceType] ?? 0.5;
    let confidence = Math.max(item.confidence, floor);

    if (item.sourceType === 'llm') confidence = Math.min(confidence, LLM_CAP);
    if (item.metadata?.derived === true) confidence = Math.min(confidence, 0.6);
    if (item.verified === 'low_confidence') confidence = Math.min(confidence, item.confidence);

    confidence = Math.max(0, Math.min(0.98, confidence));

    let verified: VerificationStatus = item.verified;
    if (verified === 'unverified') {
      if (confidence >= 0.85) verified = 'source_verified';
      else if (confidence < 0.6) verified = 'low_confidence';
    }

    return { ...item, confidence, verified };
  });
}
