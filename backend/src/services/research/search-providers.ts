import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { compoundSearch } from './compound-search';
import type { GeneratedQuery } from './search-query-generator';
import type { SerpResult } from './types';

const RESULTS_PER_QUERY = 6;

interface Provider {
  name: string;
  available(): boolean;
  /** Queries this provider can afford per job */
  budget: number;
  run(query: GeneratedQuery): Promise<SerpResult[]>;
}

const googleCse: Provider = {
  name: 'google-cse',
  budget: 30,
  available: () => Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID),
  async run(q) {
    return withRetry(
      async (signal) => {
        const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_CSE_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(q.query)}&num=${RESULTS_PER_QUERY}`;
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`CSE HTTP ${response.status}`);
        const json = (await response.json()) as {
          items?: Array<{ title?: string; link?: string; snippet?: string }>;
        };
        return (json.items ?? []).map((item, i) => ({
          query: q.query,
          intent: q.intent,
          title: item.title ?? '',
          url: item.link ?? '',
          snippet: item.snippet,
          rank: i + 1,
          provider: 'google-cse',
        }));
      },
      { service: 'google-cse', timeoutMs: 12_000, retries: 1 },
    );
  },
};

const serper: Provider = {
  name: 'serper',
  budget: 30,
  available: () => Boolean(process.env.SERPER_API_KEY),
  async run(q) {
    return withRetry(
      async (signal) => {
        const response = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          signal,
          headers: {
            'X-API-KEY': process.env.SERPER_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: q.query, num: RESULTS_PER_QUERY }),
        });
        if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
        const json = (await response.json()) as {
          organic?: Array<{ title?: string; link?: string; snippet?: string }>;
        };
        return (json.organic ?? []).map((item, i) => ({
          query: q.query,
          intent: q.intent,
          title: item.title ?? '',
          url: item.link ?? '',
          snippet: item.snippet,
          rank: i + 1,
          provider: 'serper',
        }));
      },
      { service: 'serper', timeoutMs: 12_000, retries: 1 },
    );
  },
};

/**
 * Keyless free default: DuckDuckGo's HTML endpoint. Returns real organic
 * results with no API key. The actual result URL is wrapped in a
 * duckduckgo.com/l/?uddg=<encoded> redirect that we decode. This is the
 * engine the whole pipeline runs on when no paid search key is configured.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function decodeDdgUrl(href: string): string | null {
  const uddg = href.match(/[?&]uddg=([^&]+)/)?.[1];
  if (uddg) {
    try {
      return decodeURIComponent(uddg);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//.test(href)) return href;
  return null;
}

function parseDdgHtml(html: string, q: GeneratedQuery): SerpResult[] {
  const results: SerpResult[] = [];
  // Each result: <a ... class="result__a" href="...">TITLE</a> ... optional snippet
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(decodeHtmlEntities(m[1]!.replace(/<[^>]+>/g, '').trim()));
  }
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    const url = decodeDdgUrl(decodeHtmlEntities(m[1]!));
    const title = decodeHtmlEntities(m[2]!.replace(/<[^>]+>/g, '').trim());
    if (!url || !title) continue;
    results.push({
      query: q.query,
      intent: q.intent,
      title,
      url,
      snippet: snippets[i],
      rank: results.length + 1,
      provider: 'duckduckgo',
    });
    i++;
    if (results.length >= RESULTS_PER_QUERY) break;
  }
  return results;
}

async function ddgFetch(endpoint: string, q: GeneratedQuery, signal: AbortSignal): Promise<SerpResult[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: `q=${encodeURIComponent(q.query)}&kl=`,
  });
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  return parseDdgHtml(await response.text(), q);
}

const duckduckgo: Provider = {
  name: 'duckduckgo',
  budget: 45,
  available: () => true,
  async run(q) {
    return withRetry(
      async (signal) => {
        // POST to the HTML endpoint (most result markup); fall back to lite.
        let results = await ddgFetch('https://html.duckduckgo.com/html/', q, signal).catch(() => [] as SerpResult[]);
        if (results.length === 0) {
          results = await ddgFetch('https://lite.duckduckgo.com/lite/', q, signal);
        }
        return results;
      },
      { service: 'duckduckgo', timeoutMs: 20_000, retries: 1 },
    );
  },
};

export interface SearchRunOutput {
  results: SerpResult[];
  queriesRun: string[];
  providerUsed: string;
  errors: string[];
}

async function runOneProvider(
  provider: Provider,
  queries: GeneratedQuery[],
  pacingMs: number,
): Promise<{ results: SerpResult[]; queriesRun: string[]; errors: string[] }> {
  const toRun = queries.slice(0, provider.budget);
  const results: SerpResult[] = [];
  const queriesRun: string[] = [];
  const errors: string[] = [];
  let consecutiveFailures = 0;

  for (const q of toRun) {
    try {
      const batch = await provider.run(q);
      results.push(...batch);
      queriesRun.push(q.query);
      consecutiveFailures = batch.length > 0 ? 0 : consecutiveFailures + 1;
    } catch (err) {
      errors.push(`${q.query}: ${err instanceof Error ? err.message : String(err)}`);
      consecutiveFailures++;
    }
    // Provider down or hard rate-limiting: stop burning the whole budget
    if (consecutiveFailures >= 5) {
      logger.warn({ provider: provider.name }, 'search provider failing repeatedly, stopping');
      break;
    }
    if (pacingMs > 0) await new Promise((r) => setTimeout(r, pacingMs));
  }
  return { results, queriesRun, errors };
}

function dedupeResults(results: SerpResult[]): SerpResult[] {
  const seen = new Set<string>();
  const out: SerpResult[] = [];
  for (const r of results) {
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Runs generated queries through the best available provider.
 *
 * - Paid providers (CSE/Serper) run first when configured.
 * - Keyless default: Groq compound (real server-side web search, reliable and
 *   free) as the backbone, supplemented by a small batch of DuckDuckGo
 *   `site:`-style queries (heavily paced to dodge DDG's burst rate-limit).
 *
 * `companyName` enables the compound backbone; without it (e.g. handle
 * expansion) only the query-based providers run. Never throws — returns an
 * empty set for the pipeline to react to.
 */
export async function runSearchProviders(
  queries: GeneratedQuery[],
  companyName?: string,
): Promise<SearchRunOutput> {
  const errors: string[] = [];
  const primary = [googleCse, serper].find((p) => p.available());

  if (primary) {
    const out = await runOneProvider(primary, queries, 0);
    errors.push(...out.errors);
    if (out.results.length > 0) {
      logger.info(
        { provider: primary.name, queries: out.queriesRun.length, results: out.results.length },
        'search providers complete',
      );
      return { results: out.results, queriesRun: out.queriesRun, providerUsed: primary.name, errors };
    }
    logger.warn({ provider: primary.name }, 'primary provider returned nothing, using keyless path');
  }

  const results: SerpResult[] = [];
  const queriesRun: string[] = [];

  // Compound backbone (reliable real search results)
  if (companyName) {
    const compound = await compoundSearch(companyName);
    results.push(...compound.results);
    errors.push(...compound.errors);
    if (compound.results.length > 0) queriesRun.push(`compound:${companyName}`);
  }

  // DuckDuckGo supplement — prioritize the exact-match site:/filetype: queries
  // it handles best, small volume + long pacing to avoid the 202 bot block.
  const ddgQueries = queries
    .filter((q) => /site:|filetype:/.test(q.query))
    .slice(0, 10);
  const ddg = await runOneProvider(duckduckgo, ddgQueries, 1_500);
  results.push(...ddg.results);
  queriesRun.push(...ddg.queriesRun);
  errors.push(...ddg.errors);

  const deduped = dedupeResults(results);
  logger.info(
    { compound: companyName ? 'yes' : 'no', ddg: ddg.queriesRun.length, results: deduped.length },
    'search providers complete',
  );
  return { results: deduped, queriesRun, providerUsed: companyName ? 'groq-compound+duckduckgo' : 'duckduckgo', errors };
}
