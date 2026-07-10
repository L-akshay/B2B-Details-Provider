import { geminiGenerateWithFallback } from '../lib/gemini';
import { logger } from '../lib/logger';
import { withRetry } from '../lib/retry';
import { normalizeDomain } from '../lib/serviceResult';

/**
 * Pulls a domain out of free text — e.g. the requester wrote
 * "medical devices company, website bioadvance.com.mx" in extra_info.
 * A user-supplied domain outranks every automated resolution.
 */
export function domainFromText(text?: string): string | null {
  if (!text) return null;
  const match = text.match(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,})(?:\/\S*)?/i,
  );
  return match?.[1] ? normalizeDomain(match[1]) : null;
}

const NON_OFFICIAL_DOMAINS =
  /wikipedia\.org|wikidata\.org|linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|crunchbase\.com|bloomberg\.com|glassdoor|indeed\./i;

/** Keyless, quota-free lookup via DuckDuckGo's instant-answer API. */
async function ddgOfficialSite(companyName: string): Promise<string | null> {
  try {
    return await withRetry(
      async (signal) => {
        const response = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(companyName)}&format=json&no_html=1&skip_disambig=1`,
          { signal, headers: { 'User-Agent': 'company-research-tool/1.0' } },
        );
        if (!response.ok) throw new Error(`DDG HTTP ${response.status}`);
        const json = (await response.json()) as {
          AbstractURL?: string;
          Results?: Array<{ FirstURL?: string }>;
        };
        const candidates = [json.Results?.[0]?.FirstURL, json.AbstractURL].filter(
          (url): url is string => Boolean(url),
        );
        for (const candidate of candidates) {
          if (NON_OFFICIAL_DOMAINS.test(candidate)) continue;
          const domain = normalizeDomain(candidate);
          if (domain) return domain;
        }
        return null;
      },
      { service: 'ddg-domain', timeoutMs: 10_000, retries: 1 },
    );
  } catch {
    return null;
  }
}

/**
 * Last-resort domain resolution, for companies absent from Wikidata and
 * missed by the compound pass (typical for small/local businesses). Without
 * a domain the whole website branch of the pipeline — scrape, contact
 * harvest, DNS, tech stack — is skipped, so this exhausts search grounding
 * first and a keyless DuckDuckGo lookup after it.
 */
export async function resolveDomainViaSearch(
  companyName: string,
  extraInfo?: string,
): Promise<string | null> {
  try {
    const { text } = await geminiGenerateWithFallback({
      service: 'domain-resolver',
      prompt: `What is the official website of the company "${companyName}"${
        extraInfo ? ` (${extraInfo})` : ''
      }? Use web search. Reply with ONLY the bare domain (e.g. example.com) — no protocol, no path, no other words. If you cannot find it, reply exactly UNKNOWN.`,
      useSearchGrounding: true,
      temperature: 0,
      timeoutMs: 45_000,
    });
    const candidate = text.trim().split(/\s+/).pop() ?? '';
    const domain = normalizeDomain(candidate);
    if (domain) return domain;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'search-based domain resolution failed, trying DuckDuckGo',
    );
  }
  return ddgOfficialSite(companyName);
}
