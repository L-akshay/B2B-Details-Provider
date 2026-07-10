import { geminiGenerateWithFallback } from '../lib/gemini';
import { parseJsonLenient } from '../lib/json';
import { logger } from '../lib/logger';
import { buildExtractionPrompt } from '../prompts/extraction-prompt';
import type { EvidenceBundle } from '../types/evidence';
import { companyReportJsonSchema, type CompanyReport } from '../types/schema';

export interface GeminiExtractionResult {
  report: CompanyReport;
  groundingUrls: string[];
}

/**
 * Extraction pass B: Gemini with the Google Search grounding tool.
 * Grounding and responseSchema are mutually exclusive on the Gemini API, so
 * the grounded attempt enforces JSON by prompt; if every grounded attempt
 * fails (quota, empty thinking-only completions), we fall back to an
 * ungrounded strict-schema extraction so pass B still contributes an
 * independent read of the evidence.
 */
export async function geminiExtraction(
  evidence: EvidenceBundle,
): Promise<GeminiExtractionResult> {
  try {
    const { text, groundingUrls } = await geminiGenerateWithFallback({
      service: 'gemini-extraction',
      prompt: buildExtractionPrompt(evidence, 'gemini'),
      useSearchGrounding: true,
      temperature: 0.1,
      timeoutMs: 120_000,
    });
    return { report: parseJsonLenient<CompanyReport>(text), groundingUrls };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'grounded gemini extraction failed, falling back to ungrounded strict-schema extraction',
    );
    const { text } = await geminiGenerateWithFallback({
      service: 'gemini-extraction-ungrounded',
      prompt: buildExtractionPrompt(evidence, 'gemini-ungrounded'),
      temperature: 0.1,
      timeoutMs: 120_000,
      responseSchema: companyReportJsonSchema,
    });
    return { report: parseJsonLenient<CompanyReport>(text), groundingUrls: [] };
  }
}
