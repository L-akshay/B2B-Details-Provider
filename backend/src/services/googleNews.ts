import { XMLParser } from 'fast-xml-parser';
import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { NewsItem, ServiceResult } from '../types/schema';

const MAX_ITEMS = 6;

async function fetchFeed(query: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return withRetry(
    async (signal) => {
      const response = await fetch(url, {
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; company-research-tool/1.0)' },
      });
      if (!response.ok) throw new Error(`Google News RSS HTTP ${response.status}`);
      const xml = await response.text();

      const parsed = new XMLParser().parse(xml) as {
        rss?: { channel?: { item?: unknown } };
      };
      const rawItems = parsed.rss?.channel?.item;
      const list = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

      return list.slice(0, MAX_ITEMS).map((item) => {
        const record = item as { title?: string; link?: string; pubDate?: string };
        const date = record.pubDate ? new Date(record.pubDate) : null;
        return {
          headline: String(record.title ?? ''),
          url: String(record.link ?? ''),
          date: date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '',
        };
      });
    },
    { service: 'google-news', timeoutMs: 15_000 },
  );
}

/**
 * Recent headlines from the Google News RSS feed — free, no key, real URLs
 * and publication dates (unlike model-recalled "news"). Tries the exact
 * phrase first; long/legal names rarely appear verbatim in headlines, so an
 * unquoted query is the fallback.
 */
export async function googleNewsSearch(companyName: string): Promise<ServiceResult<NewsItem[]>> {
  const sourceUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${companyName}"`)}`;
  try {
    let items = await fetchFeed(`"${companyName}"`);
    if (items.length === 0) {
      items = await fetchFeed(companyName);
    }
    if (items.length === 0) throw new Error(`no news items found for "${companyName}"`);
    return ok(items, sourceUrl);
  } catch (err) {
    return fail('google-news', sourceUrl, err);
  }
}
