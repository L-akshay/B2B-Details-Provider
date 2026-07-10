import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { publicFetch } from './public-fetch';
import type { CrawledPage } from './types';

const MAX_PAGES = Number(process.env.CRAWLER_MAX_PAGES) || 50;
const MAX_DEPTH = Number(process.env.CRAWLER_MAX_DEPTH) || 2;
const CONCURRENCY = 3;
const DELAY_MS = 350;
const MIN_TEXT_FOR_STATIC = 400;

const COMMON_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/acerca-de',
  '/acerca-de-nosotros',
  '/contact',
  '/contact-us',
  '/contacto',
  '/nosotros',
  '/quienes-somos',
  '/privacy',
  '/privacy-policy',
  '/aviso-de-privacidad',
  '/legal',
  '/terms',
  '/terminos',
  '/terminos-y-condiciones',
  '/careers',
  '/team',
  '/equipo',
  '/blog',
  '/news',
  '/noticias',
  '/products',
  '/productos',
  '/services',
  '/servicios',
  '/catalog',
  '/catalogo',
  '/brochure',
  '/descargas',
  '/downloads',
  '/sitemap.xml',
  '/robots.txt',
];

const INTERESTING_LINK_RE =
  /contact|about|privacy|aviso|legal|product|servic|news|noticia|team|equipo|catalog|nosotros|quienes|historia|empresa/i;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface CrawlOutput {
  pages: CrawledPage[];
  pdfLinks: string[];
  attempts: Array<{ url: string; status: number; source: CrawledPage['source']; contentLength?: number; error?: string }>;
  disallowedPaths: string[];
}

function classifyPageKind(url: string): CrawledPage['kind'] {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path === '/' || path === '') return 'home';
  if (/contact|contacto/.test(path)) return 'contact';
  if (/about|nosotros|quienes|acerca|historia|empresa/.test(path)) return 'about';
  if (/privacy|aviso|legal|term/.test(path)) return 'legal';
  if (/team|equipo|leadership|people/.test(path)) return 'team';
  if (/product|servic|catalog/.test(path)) return 'products';
  if (/news|noticia|blog|press/.test(path)) return 'news';
  return 'other';
}

async function fetchRaw(url: string): Promise<{ status: number; finalUrl: string; html: string; headers: Record<string, string> }> {
  return withRetry(
    async (signal) => {
      const response = await publicFetch(url, {
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const html = await response.text();
      return { status: response.status, finalUrl: response.url || url, html, headers };
    },
    { service: 'crawler-fetch', timeoutMs: 20_000, retries: 1 },
  );
}

/** Firecrawl fallback for JS-heavy pages that render almost no static text. */
async function firecrawlHtml(url: string): Promise<string | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  try {
    return await withRetry(
      async (signal) => {
        const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formats: ['html'], onlyMainContent: false, timeout: 30_000 }),
        });
        if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
        const json = (await response.json()) as { success?: boolean; data?: { html?: string } };
        return json.success && json.data?.html ? json.data.html : null;
      },
      { service: 'firecrawl-fallback', timeoutMs: 45_000, retries: 0 },
    );
  } catch {
    return null;
  }
}

function parsePage(
  url: string,
  status: number,
  finalUrl: string,
  html: string,
  headers: Record<string, string>,
  source: CrawledPage['source'],
): CrawledPage {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      links.push(new URL(href, finalUrl).toString());
    } catch {
      // ignore malformed
    }
  });

  const meta: Record<string, string> = {};
  $('meta').each((_, el) => {
    const name = $(el).attr('name') ?? $(el).attr('property');
    const content = $(el).attr('content');
    if (name && content) meta[name.toLowerCase()] = content;
  });
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) meta['canonical'] = canonical;

  return {
    url,
    status,
    finalUrl,
    title: $('title').first().text().trim(),
    html,
    text,
    links: [...new Set(links)],
    meta,
    headers,
    source,
    fetchedAt: new Date().toISOString(),
    kind: classifyPageKind(finalUrl),
  };
}

async function fetchRobotsAndSitemap(base: string): Promise<{ disallowed: string[]; sitemapUrls: string[] }> {
  const disallowed: string[] = [];
  const sitemaps: string[] = [`${base}/sitemap.xml`];
  try {
    const robots = await fetchRaw(`${base}/robots.txt`);
    if (robots.status === 200) {
      for (const line of robots.html.split('\n')) {
        const disallow = line.match(/^\s*Disallow:\s*(\S+)/i)?.[1];
        if (disallow) disallowed.push(disallow);
        const sitemap = line.match(/^\s*Sitemap:\s*(\S+)/i)?.[1];
        if (sitemap) sitemaps.push(sitemap);
      }
    }
  } catch {
    // robots.txt is optional
  }

  const sitemapUrls: string[] = [];
  for (const sitemapUrl of [...new Set(sitemaps)].slice(0, 2)) {
    try {
      const sitemap = await fetchRaw(sitemapUrl);
      if (sitemap.status !== 200) continue;
      for (const match of sitemap.html.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        sitemapUrls.push(match[1]!);
        if (sitemapUrls.length >= 150) break;
      }
    } catch {
      // sitemap optional
    }
  }
  return { disallowed, sitemapUrls };
}

function isDisallowed(url: string, disallowed: string[]): boolean {
  try {
    const path = new URL(url).pathname;
    if (disallowed.includes('/')) return true;
    return disallowed.some((rule) => path.startsWith(rule.replace(/\*$/, '')));
  } catch {
    return true;
  }
}

/**
 * Script-first polite crawler: fetch + Cheerio, robots.txt respected,
 * sitemap-aware, common contact/about/legal paths always attempted, nav and
 * footer links followed to depth 2, Firecrawl used only as a JS-heavy
 * page fallback. Only public pages, rate-limited, capped at MAX_PAGES.
 */
export async function crawlWebsite(domain: string): Promise<CrawlOutput> {
  const base = `https://${domain}`;
  const attempts: CrawlOutput['attempts'] = [];
  const pages: CrawledPage[] = [];
  const pdfLinks = new Set<string>();
  const visited = new Set<string>();

  const { disallowed, sitemapUrls } = await fetchRobotsAndSitemap(base);

  const queue: Array<{ url: string; depth: number }> = [];
  const enqueue = (url: string, depth: number) => {
    let normalized: string;
    try {
      const u = new URL(url);
      if (!u.hostname.replace(/^www\./, '').endsWith(domain)) return;
      u.hash = '';
      u.search = '';
      normalized = u.toString().replace(/\/$/, '');
    } catch {
      return;
    }
    if (visited.has(normalized) || isDisallowed(normalized, disallowed)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|css|js|ico|zip|mp4|webm|woff2?)$/i.test(normalized)) return;
    if (/\.pdf$/i.test(normalized)) {
      pdfLinks.add(normalized);
      return;
    }
    visited.add(normalized);
    queue.push({ url: normalized, depth });
  };

  for (const path of COMMON_PATHS) enqueue(`${base}${path}`, 0);
  for (const url of sitemapUrls) {
    if (INTERESTING_LINK_RE.test(url) || /\.pdf$/i.test(url)) enqueue(url, 1);
  }

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const batch = queue.splice(0, CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ url, depth }) => {
        const raw = await fetchRaw(url);
        return { url, depth, raw };
      }),
    );

    for (let i = 0; i < settled.length; i++) {
      const item = settled[i]!;
      const queued = batch[i]!;
      if (item.status === 'rejected') {
        attempts.push({
          url: queued.url,
          status: 0,
          source: 'custom_crawler',
          error: String(item.reason instanceof Error ? item.reason.message : item.reason),
        });
        continue;
      }
      const { url, depth, raw } = item.value;
      attempts.push({ url, status: raw.status, source: 'custom_crawler', contentLength: raw.html.length });
      if (raw.status !== 200 || !/text\/html/i.test(raw.headers['content-type'] ?? 'text/html')) continue;

      let page = parsePage(url, raw.status, raw.finalUrl, raw.html, raw.headers, 'custom_crawler');

      // JS-heavy page: static body nearly empty → try Firecrawl render
      if (page.text.length < MIN_TEXT_FOR_STATIC && page.kind !== 'other') {
        const rendered = await firecrawlHtml(url);
        if (rendered) {
          page = parsePage(url, raw.status, raw.finalUrl, rendered, raw.headers, 'firecrawl');
          attempts.push({ url, status: 200, source: 'firecrawl', contentLength: rendered.length });
        }
      }

      pages.push(page);

      if (depth < MAX_DEPTH) {
        for (const link of page.links) {
          if (/\.pdf$/i.test(link)) {
            pdfLinks.add(link);
            continue;
          }
          if (INTERESTING_LINK_RE.test(link)) enqueue(link, depth + 1);
        }
      }
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  logger.info({ domain, pages: pages.length, pdfs: pdfLinks.size }, 'website crawl complete');
  return { pages, pdfLinks: [...pdfLinks].slice(0, 25), attempts, disallowedPaths: disallowed };
}
