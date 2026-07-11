import { logger } from '../../lib/logger';
import { publicFetch } from './public-fetch';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * Mines well-known PUBLIC files that plain crawling misses:
 *  - /.well-known/security.txt → security-contact emails
 *  - /humans.txt → team/author names
 *  - /wp-json/wp/v2/pages|posts → WordPress page/post titles (products, news)
 *  - RSS/Atom feeds → dated news items
 * All deterministic, all public endpoints, failures degrade to [].
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

async function fetchText(url: string, timeoutMs = 10_000): Promise<{ ok: boolean; text: string; contentType: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await publicFetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, text: '', contentType: '' };
    return { ok: true, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
  } catch {
    return { ok: false, text: '', contentType: '' };
  }
}

interface WpItem {
  title?: { rendered?: string };
  link?: string;
  date?: string;
}

export async function discoverPublicFiles(domain: string): Promise<{ evidence: EvidenceItem[]; errors: Record<string, string> }> {
  const base = `https://${domain}`;
  const evidence: EvidenceItem[] = [];
  const errors: Record<string, string> = {};

  // security.txt — RFC 9116 contact info
  for (const path of ['/.well-known/security.txt', '/security.txt']) {
    const res = await fetchText(`${base}${path}`);
    if (!res.ok || res.text.length > 10_000 || /<html/i.test(res.text)) continue;
    for (const m of res.text.matchAll(EMAIL_RE)) {
      evidence.push(
        makeEvidence({
          field: 'email',
          value: m[0].toLowerCase(),
          sourceUrl: `${base}${path}`,
          sourceType: 'official_website',
          extractedBy: 'regex',
          confidence: 0.85,
          evidenceText: 'listed in security.txt',
          domain,
        }),
      );
    }
    break;
  }

  // humans.txt — sometimes lists team members
  {
    const res = await fetchText(`${base}/humans.txt`);
    if (res.ok && res.text.length < 8_000 && !/<html/i.test(res.text)) {
      for (const m of res.text.matchAll(/(?:name|developer|author|designer)\s*[:=]\s*([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){1,2})/gi)) {
        evidence.push(
          makeEvidence({
            field: 'key_person',
            value: m[1]!.trim(),
            sourceUrl: `${base}/humans.txt`,
            sourceType: 'official_website',
            extractedBy: 'regex',
            confidence: 0.6,
            evidenceText: m[0].slice(0, 120),
            domain,
          }),
        );
      }
    }
  }

  // WordPress REST — public pages/posts reveal products and dated news
  const wpPages = await fetchText(`${base}/wp-json/wp/v2/pages?per_page=50&_fields=title,link`);
  if (wpPages.ok && wpPages.contentType.includes('json')) {
    try {
      const items = JSON.parse(wpPages.text) as WpItem[];
      for (const item of items.slice(0, 50)) {
        const title = item.title?.rendered?.replace(/<[^>]+>/g, '').trim();
        if (!title || !item.link) continue;
        if (/producto|product|servicio|service|sistema|system|equipo/i.test(title)) {
          evidence.push(
            makeEvidence({
              field: 'products_services',
              value: title.slice(0, 120),
              sourceUrl: item.link,
              sourceType: 'official_website',
              extractedBy: 'api',
              confidence: 0.7,
              evidenceText: 'WordPress page title',
              domain,
            }),
          );
        }
      }
    } catch (err) {
      errors['wp-pages'] = String(err);
    }
  }

  const wpPosts = await fetchText(`${base}/wp-json/wp/v2/posts?per_page=20&_fields=title,link,date`);
  if (wpPosts.ok && wpPosts.contentType.includes('json')) {
    try {
      const items = JSON.parse(wpPosts.text) as WpItem[];
      for (const item of items.slice(0, 20)) {
        const title = item.title?.rendered?.replace(/<[^>]+>/g, '').trim();
        if (!title || !item.link) continue;
        evidence.push(
          makeEvidence({
            field: 'news',
            value: title.slice(0, 160),
            sourceUrl: item.link,
            sourceType: 'official_website',
            extractedBy: 'api',
            confidence: 0.75,
            evidenceText: 'WordPress blog post',
            metadata: { date: item.date?.slice(0, 10) },
            domain,
          }),
        );
      }
    } catch (err) {
      errors['wp-posts'] = String(err);
    }
  }

  // RSS/Atom feeds — dated news/announcements
  for (const path of ['/feed', '/rss', '/atom.xml', '/blog/feed']) {
    const res = await fetchText(`${base}${path}`);
    if (!res.ok || !/xml|rss|atom/i.test(res.contentType + res.text.slice(0, 100))) continue;
    const items = [...res.text.matchAll(/<item>[\s\S]*?<\/item>|<entry>[\s\S]*?<\/entry>/gi)].slice(0, 15);
    for (const block of items) {
      const title = block[0].match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
      const link =
        block[0].match(/<link[^>]*>([^<]+)<\/link>/i)?.[1]?.trim() ??
        block[0].match(/<link[^>]*href="([^"]+)"/i)?.[1];
      const date = block[0].match(/<pubDate>([^<]+)<\/pubDate>|<updated>([^<]+)<\/updated>/i);
      if (!title || !link) continue;
      evidence.push(
        makeEvidence({
          field: 'news',
          value: title.slice(0, 160),
          sourceUrl: link,
          sourceType: 'official_website',
          extractedBy: 'api',
          confidence: 0.75,
          evidenceText: 'RSS/Atom feed item',
          metadata: { date: (date?.[1] ?? date?.[2])?.slice(0, 25) },
          domain,
        }),
      );
    }
    if (items.length > 0) break; // one working feed is enough
  }

  logger.info({ domain, evidence: evidence.length }, 'public-file discovery complete');
  return { evidence, errors };
}
