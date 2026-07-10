import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import type { SerpResult } from './types';

/**
 * Groq's compound models run real web searches server-side and expose the
 * raw results in `executed_tools[].search_results`. We use ONLY those real
 * URLs (never the model's prose, which can compose plausible-but-wrong URLs),
 * so this is a genuine keyless SERP source, not AI invention — every URL is
 * something the search tool actually returned and scripts will verify.
 */

interface ExecutedTool {
  type?: string;
  search_results?: unknown;
}

interface CompoundMessage {
  content?: string;
  executed_tools?: ExecutedTool[];
}

function extractToolResults(message: CompoundMessage, mission: string): SerpResult[] {
  const out: SerpResult[] = [];
  for (const tool of message.executed_tools ?? []) {
    const raw = tool.search_results;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown[] }).results)
        ? (raw as { results: unknown[] }).results
        : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { url?: string; title?: string; content?: string; snippet?: string };
      if (!rec.url || !/^https?:\/\//.test(rec.url)) continue;
      out.push({
        query: mission,
        intent: 'business',
        title: rec.title ?? '',
        url: rec.url,
        snippet: (rec.content ?? rec.snippet ?? '').slice(0, 400),
        rank: out.length + 1,
        provider: 'groq-compound',
      });
    }
  }
  return out;
}

async function runOneMission(companyName: string, mission: string, model: string): Promise<SerpResult[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return [];
  return withRetry(
    async (signal) => {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: `Use web search to research the company "${companyName}". ${mission} Search thoroughly and cite the real pages you find. Keep your written answer short — the search results themselves are what matters.`,
            },
          ],
          temperature: 0.1,
          max_tokens: 700,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Groq compound HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const json = (await response.json()) as { choices?: Array<{ message?: CompoundMessage }> };
      const message = json.choices?.[0]?.message;
      return message ? extractToolResults(message, mission) : [];
    },
    // retries 0: on a 429 fail straight to the next model/mission rather than
    // waiting out a 30-60s rate-limit window — DDG + the crawl cover the gap.
    { service: 'groq-compound-search', timeoutMs: 90_000, retries: 0 },
  );
}

// Kept to 3 broad missions — each compound call pulls web content and is
// token-heavy, so on Groq's free tier (8k TPM) more than this storms 429s.
const MISSIONS = [
  'Find its official website and all official social profiles: LinkedIn company page, Instagram, Facebook, YouTube, TikTok. Also its contact page, emails, phone numbers, and office addresses.',
  'Find the people who work there — CEO, founders, directors, senior managers — and their personal LinkedIn profile URLs (linkedin.com/in/...).',
  'Find its products, services, industry, markets served, clients, partners, recent news, certifications, awards, and founding year.',
];

/**
 * Runs broad compound "search missions" (each triggers multiple internal
 * Google searches) and returns the union of real search-result URLs.
 *
 * Missions run SEQUENTIALLY: compound calls are token-heavy and Groq's free
 * tier is 8k TPM, so firing them together triggers a 429 storm. compound-mini
 * (lighter) is tried first; the full model is a fallback only when mini
 * yields nothing. withRetry honors the API's "try again in Xs" hint so the
 * sequence self-paces under rate limits.
 */
export async function compoundSearch(companyName: string): Promise<{ results: SerpResult[]; errors: string[] }> {
  const results: SerpResult[] = [];
  const errors: string[] = [];

  for (const mission of MISSIONS) {
    try {
      // Full model first (richer results); mini is the fallback on 429/413.
      let batch = await runOneMission(companyName, mission, 'groq/compound').catch(() => null);
      if (!batch || batch.length === 0) {
        batch = await runOneMission(companyName, mission, 'groq/compound-mini').catch(() => []);
      }
      results.push(...batch);
    } catch (err) {
      errors.push(`compound "${mission.slice(0, 30)}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info({ results: results.length, errors: errors.length }, 'compound search complete');
  return { results, errors };
}
