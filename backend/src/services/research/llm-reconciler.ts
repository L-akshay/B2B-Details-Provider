import { geminiGenerateWithFallback } from '../../lib/gemini';
import { groqChat, GROQ_FALLBACK_MODEL } from '../../lib/groq';
import { parseJsonLenient } from '../../lib/json';
import { logger } from '../../lib/logger';
import type { CompanyReport } from '../../types/schema';
import type { MergedEvidence } from './evidence-deduper';
import type { CrawledPage } from './types';

/** How much raw website text to feed the writer (chars). Bigger = richer. */
const PAGE_CONTEXT_BUDGET = 18_000;
const PER_PAGE_CAP = 3_000;

// Most information-dense page kinds first, so the budget is spent where the
// real detail lives (about/products/services) before nav-heavy pages.
const KIND_PRIORITY: Record<string, number> = {
  about: 0,
  products: 1,
  home: 2,
  news: 3,
  team: 4,
  legal: 5,
  contact: 6,
  other: 7,
};

/**
 * Condensed, source-labelled dump of the company's own page text. This is the
 * raw material that lets the writer produce a DETAILED profile and a long
 * product list — the evidence digest alone is too sparse for real depth.
 */
function buildPageContext(pages: CrawledPage[], selectedDomain?: string): string {
  const onDomain = pages.filter((p) => {
    const u = p.finalUrl ?? p.url;
    return !selectedDomain || u.includes(selectedDomain);
  });
  const sorted = onDomain.sort(
    (a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9),
  );
  const parts: string[] = [];
  let budget = PAGE_CONTEXT_BUDGET;
  const seenKinds = new Map<string, number>();
  for (const page of sorted) {
    if (budget <= 0) break;
    // don't let one kind (e.g. many product pages) eat everything
    const kindCount = seenKinds.get(page.kind) ?? 0;
    if (kindCount >= 4) continue;
    const text = page.text.replace(/\s+/g, ' ').trim();
    if (text.length < 120) continue;
    seenKinds.set(page.kind, kindCount + 1);
    const chunk = `### ${page.kind} — ${page.title ?? ''} (${page.finalUrl ?? page.url})\n${text.slice(0, PER_PAGE_CAP)}`;
    parts.push(chunk.slice(0, budget));
    budget -= chunk.length;
  }
  return parts.join('\n\n');
}

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

const PROMPT_RULES = `You are the final writing stage of an EVIDENCE-FIRST company-research pipeline. Scripts already collected the hard facts (contacts, domain, socials, people). Your job is to READ the structured evidence AND the raw website content below, and write a THOROUGH, DETAILED business profile from them.

Produce as much real detail as the sources support — this is a B2B intelligence report, so depth matters. Extract EVERY distinct product, service, market, client, partner, and capability that appears in the sources. Do not be brief for the sake of brevity.

ALWAYS WRITE IN ENGLISH. Much of the content may be in Spanish or another language — translate and summarize into clear, professional English. Keep proper nouns (company, product, brand, person names) in their original form.

STRICT RULES:
- Use ONLY the provided evidence and website content. Do NOT invent or recall anything from memory. If a fact isn't in the sources, leave it out.
- Do NOT fabricate emails, phones, addresses, websites, social links, or people — those come from scripts. (You may mention people/locations that appear in the website text within the narrative, but never invent them.)
- If a field has no support in the sources, return "" (string) or [] (array).
- Factual, analyst tone. No marketing fluff, but be comprehensive.

Return ONLY a JSON object with exactly these keys:
{
  "description": "1-2 sentence factual summary of what the company does",
  "overview": "3-6 detailed paragraphs: what they do, how they operate, their offerings, scale, positioning, history — everything the sources support",
  "industry": "specific industry / sub-sector",
  "business_model": "how they make money and operate (distributor, manufacturer, service, etc.), in detail",
  "target_customers": "who they sell to / serve, in detail",
  "products_services": ["EVERY distinct product line, product, or service named in the sources — be exhaustive"],
  "markets_served": ["all countries/regions/segments served"],
  "notable_clients_partners": ["named partners, clients, brands, or affiliations"],
  "competitors": ["named or clearly-implied competitors"],
  "suppliers": ["companies/brands that supply this company, if named"],
  "buyers": ["named buyer/customer types or organizations"],
  "distributors": ["named distributors/dealers/resellers"],
  "office_locations": ["all cities/offices/facilities mentioned"]
}`;

function sanitize(raw: Partial<Record<string, unknown>>): Partial<CompanyReport> {
  // Generous caps — the point of this pass is DEPTH.
  const arrayCaps: Record<string, number> = { products_services: 40, markets_served: 20 };
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) out[key] = val.trim();
    else if (Array.isArray(val)) {
      out[key] = [...new Set(val.filter((v) => typeof v === 'string' && v.trim()).map((v) => (v as string).trim()))].slice(
        0,
        arrayCaps[key] ?? 20,
      );
    }
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
  pages: CrawledPage[] = [],
): Promise<{ output: Partial<CompanyReport> | null; error?: string }> {
  const anchor = selectedDomain
    ? `\n\nThe official company is the one operating the website ${selectedDomain}. If any content clearly describes a DIFFERENT company that merely shares the name, ignore it.`
    : '';
  const pageContext = buildPageContext(pages, selectedDomain);
  const websiteBlock = pageContext ? `\n\nWEBSITE CONTENT (the company's own pages — richest source of detail):\n${pageContext}` : '';
  const prompt =
    `${PROMPT_RULES}${anchor}\n\nCOMPANY: ${companyName}\n\n` +
    `STRUCTURED EVIDENCE (deduped facts with source URLs):\n${digestEvidence(evidence, selectedDomain).slice(0, 12_000)}` +
    websiteBlock;

  try {
    const { text } = await geminiGenerateWithFallback({
      service: 'llm-reconciler',
      prompt,
      temperature: 0.1,
      timeoutMs: 120_000,
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
        maxTokens: 4_000,
        jsonObject: true,
      });
      return { output: sanitize(parseJsonLenient(text)) };
    } catch (groqErr) {
      return { output: null, error: `gemini: ${String(geminiErr)}; groq: ${String(groqErr)}` };
    }
  }
}
