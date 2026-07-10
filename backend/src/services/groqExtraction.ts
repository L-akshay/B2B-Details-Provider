import { GROQ_EXTRACTION_MODEL, GROQ_FALLBACK_MODEL, groqChat } from '../lib/groq';
import { parseJsonLenient } from '../lib/json';
import { logger } from '../lib/logger';
import { buildExtractionPrompt } from '../prompts/extraction-prompt';
import type { EvidenceBundle } from '../types/evidence';
import type { CompanyReport } from '../types/schema';

/**
 * Extraction pass A: openai/gpt-oss-120b on Groq in json_object mode, with
 * llama-3.3-70b (a separate free-tier quota bucket) as fallback.
 * Groq's free tier caps each model's tokens per minute counting
 * input + max_tokens, so the prompt uses the tight 'groq' evidence budget
 * and skips full json_schema mode (the schema alone costs ~1k tokens);
 * strict schema conformance is re-imposed by normalization + reconciliation.
 */
export async function groqExtraction(evidence: EvidenceBundle): Promise<CompanyReport> {
  const prompt = buildExtractionPrompt(evidence, 'groq');
  try {
    const content = await groqChat({
      service: 'groq-extraction',
      model: GROQ_EXTRACTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 3_000,
      timeoutMs: 90_000,
      jsonObject: true,
    });
    return parseJsonLenient<CompanyReport>(content);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'gpt-oss extraction failed, retrying on llama-3.3-70b',
    );
    const content = await groqChat({
      service: 'groq-extraction-llama',
      model: GROQ_FALLBACK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 3_000,
      timeoutMs: 90_000,
      jsonObject: true,
    });
    return parseJsonLenient<CompanyReport>(content);
  }
}

/**
 * Emergency detail pass: when the whole Gemini side is quota-dead, extract
 * the deep-detail fields from the collected evidence on Groq's llama bucket
 * so reports keep their depth without any Gemini quota at all.
 */
export async function groqDetailExtraction(evidence: EvidenceBundle): Promise<CompanyReport> {
  const content = await groqChat({
    service: 'groq-detail-fallback',
    model: GROQ_FALLBACK_MODEL,
    messages: [{ role: 'user', content: buildExtractionPrompt(evidence, 'llama-fallback') }],
    temperature: 0.1,
    maxTokens: 3_500,
    timeoutMs: 90_000,
    jsonObject: true,
  });
  return parseJsonLenient<CompanyReport>(content);
}
