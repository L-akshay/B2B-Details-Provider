import type { MergedEvidence } from './evidence-deduper';
import type { CandidateScore } from './domain-resolver';
import type { CrawledPage, EvidenceItem, ResearchDebug, SerpResult } from './types';

export interface DebugBuilderInput {
  companyInput: string;
  startedAt: string;
  finishedAt?: string;
  selectedDomain?: string | null;
  selectedDomainConfidence?: number;
  candidateDomains: CandidateScore[];
  generatedQueriesCount: number;
  serpEvidenceCount: number;
  searchQueriesRun: string[];
  serpResults: SerpResult[];
  crawledUrls: ResearchDebug['crawledUrls'];
  servicesCalled: ResearchDebug['servicesCalled'];
  serviceErrors: ResearchDebug['serviceErrors'];
  evidence: MergedEvidence[];
  rawEvidence: EvidenceItem[];
  llmInputEvidenceCount: number;
  llmOutput?: unknown;
  deterministicOverridesApplied: string[];
  finalFieldSources: Record<string, string[]>;
  fieldsFilteredDueToConfidence: string[];
  fieldsIgnoredDueToSchemaMismatch: string[];
  warnings: string[];
  pages: CrawledPage[];
}

function countByField(items: EvidenceItem[] | MergedEvidence[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.field] = (counts[item.field] ?? 0) + 1;
  return counts;
}

function topResultsByQuery(results: SerpResult[]): ResearchDebug['topResultsByQuery'] {
  const grouped: ResearchDebug['topResultsByQuery'] = {};
  for (const result of results) {
    const list = grouped[result.query] ?? [];
    if (list.length < 6) {
      list.push({ title: result.title, url: result.url, snippet: result.snippet });
      grouped[result.query] = list;
    }
  }
  return grouped;
}

function pick(items: EvidenceItem[], fields: string[]): EvidenceItem[] {
  return items.filter((item) => fields.includes(item.field));
}

export function buildDebugReport(input: DebugBuilderInput): ResearchDebug {
  const raw = input.rawEvidence;
  const socials = ['linkedin', 'instagram', 'facebook', 'youtube', 'x_twitter', 'tiktok', 'whatsapp'];

  return {
    companyInput: input.companyInput,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    generatedQueriesCount: input.generatedQueriesCount,
    searchResultsCount: input.serpResults.length,
    serpEvidenceCount: input.serpEvidenceCount,
    selectedDomain: input.selectedDomain ?? undefined,
    selectedDomainConfidence: input.selectedDomainConfidence,
    candidateDomains: input.candidateDomains,
    searchQueriesRun: input.searchQueriesRun,
    topResultsByQuery: topResultsByQuery(input.serpResults),
    crawledUrls: input.crawledUrls,
    servicesCalled: input.servicesCalled,
    serviceErrors: input.serviceErrors,
    evidenceCountByField: countByField(input.evidence),
    extractedBeforeAI: {
      emails: pick(raw, ['email']),
      phones: pick(raw, ['phone']),
      addresses: pick(raw, ['address']),
      socials: pick(raw, socials),
      techStack: pick(raw, ['tech_stack']),
      domains: pick(raw, ['official_website', 'alternative_domain']),
      people: pick(raw, ['key_person']),
      productsServices: pick(raw, ['products_services']),
      news: pick(raw, ['news', 'history_event']),
    },
    llmInputEvidenceCount: input.llmInputEvidenceCount,
    llmOutput: input.llmOutput,
    deterministicOverridesApplied: input.deterministicOverridesApplied,
    finalFieldSources: input.finalFieldSources,
    fieldsFilteredDueToConfidence: input.fieldsFilteredDueToConfidence,
    fieldsIgnoredDueToSchemaMismatch: input.fieldsIgnoredDueToSchemaMismatch,
    warnings: input.warnings,
  };
}
