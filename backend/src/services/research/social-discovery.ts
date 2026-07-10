import {
  makeEvidence,
  type CrawledPage,
  type EvidenceField,
  type EvidenceItem,
} from './types';

const SOCIAL_PATTERNS: Array<[EvidenceField, RegExp]> = [
  ['linkedin', /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/[^\s"'<>)\],]+/gi],
  ['instagram', /https?:\/\/(www\.)?instagram\.com\/[^\s"'<>)\],?]+/gi],
  ['facebook', /https?:\/\/(www\.|m\.)?facebook\.com\/[^\s"'<>)\],?]+/gi],
  ['youtube', /https?:\/\/(www\.)?youtube\.com\/(channel\/|c\/|user\/|@)[^\s"'<>)\],?]+/gi],
  ['x_twitter', /https?:\/\/(www\.)?(x|twitter)\.com\/[^\s"'<>)\],?]+/gi],
  ['tiktok', /https?:\/\/(www\.)?tiktok\.com\/@[^\s"'<>)\],?]+/gi],
  ['whatsapp', /https?:\/\/(wa\.me|(?:api\.)?whatsapp\.com)\/[^\s"'<>)\],]+/gi],
];

const EXCLUDE_RE =
  /sharer|share\.php|\/share(\?|\/|$)|\/intent\/|\/plugins\/|facebook\.com\/(tr|dialog|login)|instagram\.com\/(p|reel|explore)\/|(twitter|x)\.com\/(intent|share|home|search)|linkedin\.com\/(share|feed|posts)|wa\.me\/\?|whatsapp\.com\/send\?text|whatsapp\.com\/\?/i;

function cleanSocialUrl(raw: string): string {
  let url = raw.replace(/[.,;:!]+$/, '');
  const q = url.indexOf('?');
  if (q !== -1 && !/whatsapp|wa\.me/i.test(url)) url = url.slice(0, q);
  return url.replace(/\/$/, '');
}

export function extractHandle(url: string, field: EvidenceField): string | null {
  const patterns: Partial<Record<EvidenceField, RegExp>> = {
    linkedin: /linkedin\.com\/(?:company|school|showcase)\/([^/?]+)/i,
    instagram: /instagram\.com\/([^/?]+)/i,
    facebook: /facebook\.com\/([^/?]+)/i,
    youtube: /youtube\.com\/(?:c\/|user\/|@)([^/?]+)/i,
    x_twitter: /(?:x|twitter)\.com\/([^/?]+)/i,
    tiktok: /tiktok\.com\/@([^/?]+)/i,
  };
  const match = url.match(patterns[field] ?? /$^/);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Deterministic social discovery from the crawled site itself (hrefs,
 * footers, schema.org sameAs surfaces as plain URLs in HTML) plus already
 * mined SERP evidence. Site-linked profiles get 0.95 confidence; search
 * results 0.55-0.8 depending on rank. Returns discovered handles so the
 * pipeline can run follow-up handle-expansion searches.
 */
export function discoverSocialProfiles(
  pages: CrawledPage[],
  serpEvidence: EvidenceItem[],
): { evidence: EvidenceItem[]; handles: string[] } {
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const handles = new Set<string>();

  for (const page of pages) {
    const corpus = `${page.links.join('\n')}\n${page.html}`;
    for (const [field, pattern] of SOCIAL_PATTERNS) {
      for (const match of corpus.matchAll(pattern)) {
        const url = cleanSocialUrl(match[0]);
        if (EXCLUDE_RE.test(url)) continue;
        const key = `${field}:${url.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const handle = extractHandle(url, field);
        if (handle) handles.add(handle);
        evidence.push(
          makeEvidence({
            field,
            value: url,
            normalizedValue: url.toLowerCase(),
            sourceUrl: page.finalUrl,
            sourceTitle: page.title,
            pageUrl: page.finalUrl,
            sourceType: 'official_website',
            extractedBy: 'cheerio',
            confidence: 0.95,
            evidenceText: `linked from ${page.kind} page of official website`,
          }),
        );
      }
    }
  }

  // SERP-derived socials already exist as evidence; collect their handles too
  for (const item of serpEvidence) {
    const socialFields: EvidenceField[] = ['linkedin', 'instagram', 'facebook', 'youtube', 'x_twitter', 'tiktok'];
    if (socialFields.includes(item.field)) {
      const handle = extractHandle(item.value, item.field);
      if (handle) handles.add(handle);
    }
  }

  return { evidence, handles: [...handles].slice(0, 3) };
}

/** Handle expansion queries: "bioadvancemed LinkedIn" etc. */
export function handleExpansionQueries(handles: string[]): string[] {
  const networks = ['LinkedIn', 'Instagram', 'Facebook', 'YouTube', 'X', 'TikTok'];
  return handles.flatMap((handle) => networks.map((n) => `${handle} ${n}`));
}
