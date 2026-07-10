import { geminiGenerateWithFallback } from '../lib/gemini';
import { parseJsonLenient } from '../lib/json';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface SocialProfiles {
  linkedin: string;
  facebook: string;
  instagram: string;
  twitter: string;
  youtube: string;
  tiktok: string;
  whatsapp: string;
}

export function emptySocialProfiles(): SocialProfiles {
  return {
    linkedin: '',
    facebook: '',
    instagram: '',
    twitter: '',
    youtube: '',
    tiktok: '',
    whatsapp: '',
  };
}

const URL_TAIL = String.raw`[^\s"'<>\\)\],]+`;
const PATTERNS: Array<[keyof SocialProfiles, RegExp]> = [
  ['linkedin', new RegExp(String.raw`https?://([a-z]{2,3}\.)?linkedin\.com/(company|school|showcase)/${URL_TAIL}`, 'gi')],
  ['facebook', new RegExp(String.raw`https?://(www\.|m\.|[a-z]{2}-[a-z]{2}\.)?facebook\.com/${URL_TAIL}`, 'gi')],
  ['instagram', new RegExp(String.raw`https?://(www\.)?instagram\.com/${URL_TAIL}`, 'gi')],
  ['twitter', new RegExp(String.raw`https?://(www\.)?(twitter|x)\.com/${URL_TAIL}`, 'gi')],
  ['youtube', new RegExp(String.raw`https?://(www\.)?youtube\.com/(channel/|c/|user/|@)${URL_TAIL}`, 'gi')],
  ['tiktok', new RegExp(String.raw`https?://(www\.)?tiktok\.com/@${URL_TAIL}`, 'gi')],
  ['whatsapp', new RegExp(String.raw`https?://(wa\.me/|api\.whatsapp\.com/send${URL_TAIL})${URL_TAIL}?`, 'gi')],
];

// Share widgets, tracking pixels, post permalinks — not company profiles.
const EXCLUDE_RE =
  /sharer|share\.php|\/share(\?|\/|$)|\/intent\/|\/plugins\/|facebook\.com\/(tr|dialog|login)|instagram\.com\/(p|reel|explore)\/|(twitter|x)\.com\/(intent|share|home|search)|linkedin\.com\/(share|feed|posts)/i;

function cleanUrl(raw: string): string {
  let url = raw.replace(/[.,;:!]+$/, '');
  const queryIndex = url.indexOf('?');
  // WhatsApp deep links carry the phone number in the query string
  if (queryIndex !== -1 && !/whatsapp|wa\.me/i.test(url)) url = url.slice(0, queryIndex);
  return url.replace(/\/$/, '');
}

/**
 * Deterministic social profile harvesting from the scraped site's link graph
 * and raw HTML. Footer social icons are usually image-only links that vanish
 * in markdown conversion, so the AI passes never see them — regexing the raw
 * HTML is the reliable way to catch them.
 */
export function harvestSocialProfiles(links: string[], htmlDocuments: string[]): SocialProfiles {
  const corpus = [...links, ...htmlDocuments].join('\n');
  const profiles = emptySocialProfiles();

  for (const [network, pattern] of PATTERNS) {
    for (const match of corpus.matchAll(pattern)) {
      const url = cleanUrl(match[0]);
      if (EXCLUDE_RE.test(url)) continue;
      profiles[network] = url;
      break; // first non-excluded hit (footer links are canonical)
    }
  }
  return profiles;
}

/**
 * Search-grounded fallback: asks Gemini to do what a human would — google
 * the company's official profiles. Covers companies whose sites don't link
 * their own socials.
 */
export async function findSocialProfiles(
  companyName: string,
  domain: string | null,
): Promise<ServiceResult<SocialProfiles>> {
  const source = 'google-search-grounding (social profile lookup)';
  const prompt = `Find the OFFICIAL social media profiles of the company "${companyName}"${
    domain ? ` (their website is ${domain})` : ''
  }. Use web search — try queries like "${companyName} linkedin", "${companyName} facebook", "${companyName} instagram".

Return ONLY this JSON object (empty string for any profile you cannot verify as the official company account; never guess a URL):
{"linkedin": "", "facebook": "", "instagram": "", "twitter": "", "youtube": "", "tiktok": "", "whatsapp": ""}

Rules: full https URLs; company accounts only (no personal profiles, fan pages, or lookalike companies${
    domain ? ` — the account must belong to the company operating ${domain}` : ''
  }).`;

  try {
    const { text } = await geminiGenerateWithFallback({
      service: 'social-profile-search',
      prompt,
      useSearchGrounding: true,
      temperature: 0,
      timeoutMs: 60_000,
    });
    const parsed = parseJsonLenient<Partial<SocialProfiles>>(text);
    const profiles = { ...emptySocialProfiles(), ...parsed };
    for (const key of Object.keys(profiles) as Array<keyof SocialProfiles>) {
      if (typeof profiles[key] !== 'string' || !/^https?:\/\//.test(profiles[key])) {
        profiles[key] = '';
      }
    }
    return ok(profiles, source);
  } catch (err) {
    return fail('social-profile-search', source, err);
  }
}
