import type { EvidenceItem } from './types';

export interface MergedEvidence extends EvidenceItem {
  /** All source URLs that independently attest this value */
  sourceUrls: string[];
  /** Distinct source-type count feeding the multi-source boost */
  sourceCount: number;
  supportingEvidenceIds: string[];
}

/**
 * Deduplicates by (field, normalizedValue), merging source URLs and evidence
 * snippets. Two independent strong sources (distinct source types, each
 * >= 0.75) promote a value to multi_source_verified with confidence up to
 * 0.98 — the core accuracy mechanism.
 */
export function dedupeEvidence(items: EvidenceItem[]): MergedEvidence[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    const key = `${item.field}::${item.normalizedValue ?? item.value.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const merged: MergedEvidence[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.confidence - a.confidence);
    const best = list[0]!;
    const sourceUrls = [...new Set(list.map((i) => i.sourceUrl).filter(Boolean))];
    const sourceTypes = new Set(list.map((i) => i.sourceType));
    const strongIndependent = new Set(
      list.filter((i) => i.confidence >= 0.75).map((i) => i.sourceType),
    );

    let confidence = best.confidence;
    let verified = best.verified;
    if (strongIndependent.size >= 2) {
      confidence = Math.min(0.98, Math.max(confidence, 0.9) + 0.05);
      verified = 'multi_source_verified';
    }

    merged.push({
      ...best,
      confidence,
      verified,
      sourceUrls,
      sourceCount: sourceTypes.size,
      supportingEvidenceIds: list.map((i) => i.id),
      metadata: {
        ...best.metadata,
        mergedFrom: list.length,
        evidenceTexts: [...new Set(list.map((i) => i.evidenceText).filter(Boolean))].slice(0, 3),
      },
    });
  }

  return merged.sort((a, b) => b.confidence - a.confidence);
}
