import { XMLParser } from 'fast-xml-parser';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { simplifyCompanyName } from '../../lib/companyName';
import { makeEvidence, type CrawledPage, type EvidenceItem, type SerpResult } from './types';

const YEAR_NEAR_EVENT_RE =
  /((?:19|20)\d{2})[^.]{0,120}?(founded|launched|opened|expanded|acquired|established|fundad|lanz|inaugur|abri[oó]|expan|adquir|certific)/gi;
const ANNIVERSARY_RE = /(?:celebrat\w*|cumple|celebra)[^.]{0,30}?(\d{1,3})\s*(?:years|años|aniversario|anniversary)/i;

async function fetchGoogleNews(companyName: string): Promise<EvidenceItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${companyName}"`)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    return await withRetry(
      async (signal) => {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; company-research-tool/1.0)' },
        });
        if (!response.ok) throw new Error(`news HTTP ${response.status}`);
        const xml = await response.text();
        const parsed = new XMLParser().parse(xml) as { rss?: { channel?: { item?: unknown } } };
        const raw = parsed.rss?.channel?.item;
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        return list.slice(0, 6).map((item) => {
          const record = item as { title?: string; link?: string; pubDate?: string };
          const date = record.pubDate ? new Date(record.pubDate) : null;
          return makeEvidence({
            field: 'news',
            value: String(record.title ?? ''),
            sourceUrl: String(record.link ?? url),
            sourceType: 'news',
            extractedBy: 'api',
            confidence: 0.75,
            metadata: {
              date: date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '',
            },
          });
        });
      },
      { service: 'google-news', timeoutMs: 15_000, retries: 1 },
    );
  } catch (err) {
    logger.warn({ err: String(err) }, 'google news fetch failed');
    return [];
  }
}

/**
 * Timeline + news builder. News comes from Google News RSS (real URLs/dates);
 * history events are mined from about-page and PDF text. A "celebrates N
 * years" phrase yields a DERIVED founding year at reduced confidence — never
 * presented as verified unless another source confirms it.
 */
export async function buildHistoryTimeline(
  companyName: string,
  pages: CrawledPage[],
  serpResults: SerpResult[],
  pdfEvidence: EvidenceItem[],
): Promise<EvidenceItem[]> {
  const evidence: EvidenceItem[] = [];
  const searchName = simplifyCompanyName(companyName);

  // News
  let news = await fetchGoogleNews(searchName);
  if (news.length === 0 && searchName !== companyName) news = await fetchGoogleNews(companyName);
  evidence.push(...news);

  // Explicit founding years already found (schema/PDF) carry through the
  // scorer; here we mine narrative history from about pages.
  const historyText = pages
    .filter((p) => ['about', 'home', 'news'].includes(p.kind))
    .map((p) => ({ text: p.text.slice(0, 6_000), url: p.finalUrl, title: p.title }));

  for (const { text, url, title } of historyText) {
    for (const match of text.matchAll(YEAR_NEAR_EVENT_RE)) {
      evidence.push(
        makeEvidence({
          field: 'history_event',
          value: match[0].replace(/\s+/g, ' ').trim().slice(0, 160),
          sourceUrl: url,
          sourceTitle: title,
          sourceType: 'official_website',
          extractedBy: 'regex',
          confidence: 0.7,
          metadata: { year: match[1] },
        }),
      );
    }

    // Derived founding year from anniversary phrasing
    const anniversary = text.match(ANNIVERSARY_RE);
    if (anniversary?.[1]) {
      const years = Number(anniversary[1]);
      if (years > 0 && years < 150) {
        const derivedYear = new Date().getFullYear() - years;
        evidence.push(
          makeEvidence({
            field: 'founding_year',
            value: String(derivedYear),
            sourceUrl: url,
            sourceType: 'official_website',
            extractedBy: 'regex',
            confidence: 0.5,
            verified: 'low_confidence',
            evidenceText: `derived from "${anniversary[0]}"`,
            metadata: { derived: true },
          }),
        );
      }
    }
  }

  // Also surface PDF-derived founding years already collected
  for (const item of pdfEvidence) {
    if (item.field === 'founding_year') evidence.push(item);
  }

  return evidence;
}
