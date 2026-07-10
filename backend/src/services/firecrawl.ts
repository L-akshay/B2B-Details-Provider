import { logger } from '../lib/logger';
import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface ScrapedPage {
  url: string;
  markdown: string;
}

export interface ScrapedSite {
  pages: ScrapedPage[];
  /** Raw homepage HTML, kept for tech fingerprinting and contact harvesting */
  homepageHtml: string | null;
  /** Every link Firecrawl found on the homepage — used for social harvesting */
  links: string[];
}

const MAX_SUBPAGES = 4;
const MAX_MARKDOWN_CHARS = 6_000;
// English + Spanish + a few other common naming conventions for the pages
// that carry contact/team/company info.
const SUBPAGE_PATTERN =
  /\/(about|about-us|aboutus|company|contact|contact-us|contactus|team|our-team|leadership|management|who-we-are|our-story|imprint|impressum|nosotros|quienes-somos|qui[ée]nes-somos|acerca(-de)?|empresa|contacto|equipo|servicios|sobre-nosotros|a-propos|kontakt|uber-uns|ueber-uns|chi-siamo|contatti)(\/|\.html?|\/?$)/i;

interface FirecrawlScrapeData {
  markdown?: string;
  html?: string;
  links?: string[];
}

async function scrapeUrl(
  url: string,
  formats: Array<'markdown' | 'html' | 'links'>,
): Promise<FirecrawlScrapeData> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY is not set');

  return withRetry(
    async (signal) => {
      const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, formats, onlyMainContent: false, timeout: 40_000 }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Firecrawl HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      const json = (await response.json()) as { success?: boolean; data?: FirecrawlScrapeData; error?: string };
      if (!json.success || !json.data) {
        throw new Error(`Firecrawl scrape failed: ${json.error ?? 'no data returned'}`);
      }
      return json.data;
    },
    { service: 'firecrawl', timeoutMs: 60_000, retries: 1 },
  );
}

/** Free keyless URL→markdown conversion — fallback when Firecrawl fails. */
async function jinaScrape(url: string): Promise<string> {
  return withRetry(
    async (signal) => {
      const response = await fetch(`https://r.jina.ai/${url}`, {
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; company-research-tool/1.0)' },
      });
      if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim()) throw new Error('Jina Reader returned empty content');
      return text;
    },
    { service: 'jina-reader', timeoutMs: 45_000, retries: 1 },
  );
}

async function rawFetchHtml(url: string): Promise<string> {
  return withRetry(
    async (signal) => {
      const response = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    { service: 'raw-fetch', timeoutMs: 20_000, retries: 1 },
  );
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHrefs(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      links.push(new URL(match[1]!, baseUrl).toString());
    } catch {
      // relative junk, skip
    }
  }
  return links;
}

function pickSubpages(links: string[], domain: string): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const link of links) {
    try {
      const url = new URL(link);
      if (!url.hostname.replace(/^www\./, '').endsWith(domain)) continue;
      const normalized = `${url.origin}${url.pathname}`.replace(/\/$/, '');
      if (seen.has(normalized) || !SUBPAGE_PATTERN.test(url.pathname)) continue;
      seen.add(normalized);
      picked.push(normalized);
      if (picked.length >= MAX_SUBPAGES) break;
    } catch {
      // ignore malformed links
    }
  }
  return picked;
}

/**
 * Scrapes the homepage plus about/contact/team-style subpages. Firecrawl is
 * the primary scraper; if it fails (credits, blocks, outages) the fallback
 * chain is raw fetch (HTML, links, tech signals) + Jina Reader (markdown),
 * so losing Firecrawl degrades quality instead of losing the site entirely.
 * Markdown is truncated per page to respect model rate limits.
 */
export async function scrapeSite(domain: string): Promise<ServiceResult<ScrapedSite>> {
  const homeUrl = `https://${domain}`;

  try {
    const home = await scrapeUrl(homeUrl, ['markdown', 'html', 'links']);
    const pages: ScrapedPage[] = [
      { url: homeUrl, markdown: (home.markdown ?? '').slice(0, MAX_MARKDOWN_CHARS) },
    ];

    const subpageUrls = pickSubpages(home.links ?? [], domain);
    const results = await Promise.allSettled(
      subpageUrls.map((url) => scrapeUrl(url, ['markdown'])),
    );
    results.forEach((result, i) => {
      const url = subpageUrls[i];
      if (result.status === 'fulfilled' && url) {
        pages.push({ url, markdown: (result.value.markdown ?? '').slice(0, MAX_MARKDOWN_CHARS) });
      }
    });

    return ok({ pages, homepageHtml: home.html ?? null, links: home.links ?? [] }, homeUrl);
  } catch (firecrawlErr) {
    logger.warn(
      { domain, err: firecrawlErr instanceof Error ? firecrawlErr.message : String(firecrawlErr) },
      'firecrawl failed, using raw-fetch + Jina Reader fallback',
    );
  }

  try {
    const [htmlResult, jinaResult] = await Promise.allSettled([
      rawFetchHtml(homeUrl),
      jinaScrape(homeUrl),
    ]);
    const html = htmlResult.status === 'fulfilled' ? htmlResult.value : null;
    const markdown =
      jinaResult.status === 'fulfilled'
        ? jinaResult.value
        : html
          ? htmlToText(html)
          : null;
    if (!markdown) {
      throw new Error(
        `both fallback fetches failed: ${jinaResult.status === 'rejected' ? String(jinaResult.reason) : 'no content'}`,
      );
    }

    const links = html ? extractHrefs(html, homeUrl) : [];
    const pages: ScrapedPage[] = [{ url: homeUrl, markdown: markdown.slice(0, MAX_MARKDOWN_CHARS) }];

    const subpageUrls = pickSubpages(links, domain);
    const subResults = await Promise.allSettled(subpageUrls.map((url) => jinaScrape(url)));
    subResults.forEach((result, i) => {
      const url = subpageUrls[i];
      if (result.status === 'fulfilled' && url) {
        pages.push({ url, markdown: result.value.slice(0, MAX_MARKDOWN_CHARS) });
      }
    });

    return ok({ pages, homepageHtml: html, links }, homeUrl);
  } catch (err) {
    return fail('site-scrape', homeUrl, err);
  }
}
