import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface SearchHit {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Optional Google Custom Search pass (LinkedIn snippet + domain fallback).
 * Skips gracefully when GOOGLE_CSE_KEY / GOOGLE_CSE_ID are not configured —
 * Groq Compound search and Gemini grounding already cover this ground.
 */
export async function cseSearch(query: string): Promise<ServiceResult<SearchHit[]>> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  const sourceUrl = 'https://www.googleapis.com/customsearch/v1';
  if (!key || !cx) {
    return {
      data: null,
      sourceUrl,
      success: false,
      error: 'google-cse: skipped (no GOOGLE_CSE_KEY / GOOGLE_CSE_ID configured)',
    };
  }

  try {
    const url = `${sourceUrl}?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=5`;
    const hits = await withRetry(
      async (signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Google CSE HTTP ${response.status}`);
        const json = (await response.json()) as {
          items?: Array<{ title?: string; link?: string; snippet?: string }>;
        };
        return (json.items ?? []).map((item) => ({
          title: item.title ?? '',
          link: item.link ?? '',
          snippet: item.snippet ?? '',
        }));
      },
      { service: 'google-cse', timeoutMs: 15_000 },
    );
    return ok(hits, sourceUrl);
  } catch (err) {
    return fail('google-cse', sourceUrl, err);
  }
}
