import { geminiGenerateWithFallback } from '../../lib/gemini';
import { groqChat, GROQ_FALLBACK_MODEL } from '../../lib/groq';
import { parseJsonLenient } from '../../lib/json';
import { logger } from '../../lib/logger';
import type { CompanyReport } from '../../types/schema';
import type { MergedEvidence } from './evidence-deduper';

/** Fields the LLM is allowed to write. It can NEVER touch contact/domain/social facts. */
const WRITABLE = [
  'description',
  'overview',
  'industry',
  'business_model',
  'target_customers',
  'products_services',
  'markets_served',
  'notable_clients_partners',
  'competitors',
  'suppliers',
  'buyers',
  'distributors',
  'office_locations',
] as const;

/** Compact evidence into a token-cheap, ID-tagged digest for the model.
 * When a selected domain is known, on-domain evidence sorts first so the
 * model anchors on the correct company (not a same-named lookalike). */
function digestEvidence(evidence: MergedEvidence[], selectedDomain?: string): string {
  const onDomain = (item: MergedEvidence): boolean => {
    if (!selectedDomain) return false;
    return (item.sourceUrls ?? [item.sourceUrl]).some((u) => u.includes(selectedDomain));
  };
  const sorted = [...evidence].sort((a, b) => Number(onDomain(b)) - Number(onDomain(a)) || b.confidence - a.confidence);
  const byField = new Map<string, string[]>();
  for (const item of sorted) {
    if (item.confidence < 0.45) continue;
    const line = `[${item.id}] ${item.value.slice(0, 160)}${item.evidenceText ? ` — "${item.evidenceText.slice(0, 120)}"` : ''} (${item.sourceUrl})`;
    const list = byField.get(item.field) ?? [];
    if (list.length < 8) list.push(line);
    byField.set(item.field, list);
  }
  return [...byField.entries()].map(([field, lines]) => `## ${field}\n${lines.join('\n')}`).join('\n\n');
}

const PROMPT_RULES = `You are the final writing stage of an EVIDENCE-FIRST research pipeline. Scripts already collected all hard facts. Your ONLY job is to WRITE narrative/analytical fields from the evidence below.

ALWAYS WRITE IN ENGLISH. Much of the evidence may be in Spanish or another language — translate and summarize it into clear, professional English. Never output non-English prose. (Keep proper nouns — company, product, and person names — in their original form.)

STRICT RULES:
- Use ONLY the evidence provided. Do NOT invent or recall anything from memory.
- Do NOT output emails, phones, addresses, websites, social links, people, domain, DNS, or tech facts — those are handled by scripts and you must not touch them.
- Every claim must be grounded in an evidence item. If evidence is insufficient for a field, return "" (string) or [] (array).
- No marketing fluff. Factual, analyst tone.

Return ONLY a JSON object with exactly these keys:
{
  "description": "1-2 sentence factual summary",
  "overview": "2-4 paragraph factual profile assembled from the evidence",
  "industry": "",
  "business_model": "how they make money, from evidence",
  "target_customers": "who they serve, from evidence",
  "products_services": ["concrete offerings named in evidence"],
  "markets_served": ["countries/regions in evidence"],
  "notable_clients_partners": ["named partners/clients in evidence"],
  "competitors": ["only if evidence names competitors"],
  "suppliers": ["companies that supply this company, only if named in evidence"],
  "buyers": ["named buyers/customers of this company, only if in evidence"],
  "distributors": ["named distributors/dealers, only if in evidence"],
  "office_locations": ["cities/offices in evidence beyond HQ"]
}`;

function sanitize(raw: Partial<Record<string, unknown>>): Partial<CompanyReport> {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) out[key] = val.trim();
    else if (Array.isArray(val)) out[key] = val.filter((v) => typeof v === 'string' && v.trim()).slice(0, 12);
  }
  return out as Partial<CompanyReport>;
}

/**
 * End-stage AI reconciliation. Writes only narrative fields from the
 * script-collected evidence; deterministic facts are untouchable (enforced
 * both by the prompt and by assembleFinalReport, which only fills empty
 * soft fields). Tries Gemini, falls back to Groq llama, returns null on
 * total failure so the deterministic report still ships.
 */
export async function reconcileWithLLM(
  companyName: string,
  evidence: MergedEvidence[],
  selectedDomain?: string,
): Promise<{ output: Partial<CompanyReport> | null; error?: string }> {
  const anchor = selectedDomain
    ? `\n\nThe official company is the one operating the website ${selectedDomain}. If any evidence clearly describes a DIFFERENT company that merely shares the name, ignore it.`
    : '';
  const prompt = `${PROMPT_RULES}${anchor}\n\nCOMPANY: ${companyName}\n\nEVIDENCE:\n${digestEvidence(evidence, selectedDomain).slice(0, 14_000)}`;

  try {
    const { text } = await geminiGenerateWithFallback({
      service: 'llm-reconciler',
      prompt,
      temperature: 0.1,
      timeoutMs: 90_000,
    });
    return { output: sanitize(parseJsonLenient(text)) };
  } catch (geminiErr) {
    logger.warn({ err: String(geminiErr) }, 'gemini reconciler failed, trying groq llama');
    try {
      const text = await groqChat({
        service: 'llm-reconciler-groq',
        model: GROQ_FALLBACK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 2_000,
        jsonObject: true,
      });
      return { output: sanitize(parseJsonLenient(text)) };
    } catch (groqErr) {
      return { output: null, error: `gemini: ${String(geminiErr)}; groq: ${String(groqErr)}` };
    }
  }
}
