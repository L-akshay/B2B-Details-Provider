import { geminiGenerateWithFallback } from '../lib/gemini';
import { parseJsonLenient } from '../lib/json';
import { buildReconciliationPrompt } from '../prompts/reconciliation-prompt';
import { companyReportJsonSchema, type CompanyReport } from '../types/schema';

/**
 * Final reconciliation: gemini-3.5-flash with strict responseSchema (no
 * tools), merging both extraction passes under the confidence rule set.
 */
export async function geminiReconciliation(
  companyName: string,
  passA: CompanyReport | null,
  passB: CompanyReport | null,
  sourceUrls: string[],
): Promise<CompanyReport> {
  if (!passA && !passB) {
    throw new Error('both extraction passes failed — nothing to reconcile');
  }

  const prompt = buildReconciliationPrompt(companyName, passA, passB, sourceUrls);
  const { text } = await geminiGenerateWithFallback({
    service: 'gemini-reconciliation',
    prompt,
    temperature: 0,
    timeoutMs: 120_000,
    responseSchema: companyReportJsonSchema,
  });

  return parseJsonLenient<CompanyReport>(text);
}
