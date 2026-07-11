import { makeEvidence, type EvidenceField, type EvidenceItem, type SerpResult } from './types';

export type UrlClass =
  | 'official_candidate'
  | 'linkedin'
  | 'linkedin_person'
  | 'instagram'
  | 'facebook'
  | 'youtube'
  | 'x_twitter'
  | 'tiktok'
  | 'whatsapp'
  | 'pdf'
  | 'news'
  | 'directory'
  | 'registry'
  | 'careers'
  | 'review_listing'
  | 'unknown';

const DIRECTORY_HOSTS =
  /crunchbase|zoominfo|dnb\.com|opencorporates|kompass|europages|yelp|yellowpages|paginasamarillas|clutch\.co|glassdoor|indeed|apollo\.io|rocketreach|lusha|signalhire|cylex|infobel|empresite|veritrade|importkey|tradeatlas|seair\.co|cosmos\.com\.mx|marketinsidedata|importgenius|panjiva|volza|importyeti|datamexico|indiamart|justdial|tofler|zaubacorp/i;
const NEWS_HOSTS =
  /news\.google|reuters|bloomberg|forbes|techcrunch|prnewswire|businesswire|eleconomista|elfinanciero|expansion\.mx|milenio|infobae|entrepreneur|marketwatch/i;
const REGISTRY_HOSTS = /gleif|sec\.gov|gob\.mx|companieshouse|registro|boletin|dof\.gob/i;

export function classifyUrl(rawUrl: string): UrlClass {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'unknown';
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (/linkedin\.com$/.test(host) || host.endsWith('.linkedin.com')) {
    return path.startsWith('/in/') ? 'linkedin_person' : 'linkedin';
  }
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('facebook.com')) return 'facebook';
  if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'x.com' || host.includes('twitter.com')) return 'x_twitter';
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host === 'wa.me' || host.includes('whatsapp.com')) return 'whatsapp';
  if (path.endsWith('.pdf')) return 'pdf';
  if (NEWS_HOSTS.test(host)) return 'news';
  if (REGISTRY_HOSTS.test(host)) return 'registry';
  if (DIRECTORY_HOSTS.test(host)) return 'directory';
  if (/careers|jobs|empleo/.test(path) || /indeed|linkedin\.com\/jobs/.test(host)) return 'careers';
  if (/trustpilot|g2\.com|capterra|tripadvisor/.test(host)) return 'review_listing';
  return 'official_candidate';
}

const PERSON_NAME_RE = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]+){1,3}$/;

/**
 * LinkedIn people-search result titles look like
 * "Jane Doe - Chief Executive Officer - Acme | LinkedIn". Split off the
 * person name and their role. Returns null if the leading token isn't a
 * plausible person name (avoids junk becoming "people").
 */
function parseLinkedInTitle(title: string): { name: string; role: string } | null {
  const clean = title.replace(/\s*[|–-]\s*LinkedIn\s*$/i, '').trim();
  const parts = clean.split(/\s+[-–—|]\s+/);
  const name = (parts[0] ?? '').trim();
  if (!PERSON_NAME_RE.test(name)) return null;
  const role = (parts[1] ?? '').trim().slice(0, 80);
  return { name, role };
}

const CLASS_TO_FIELD: Partial<Record<UrlClass, EvidenceField>> = {
  linkedin: 'linkedin',
  instagram: 'instagram',
  facebook: 'facebook',
  youtube: 'youtube',
  x_twitter: 'x_twitter',
  tiktok: 'tiktok',
  whatsapp: 'whatsapp',
  pdf: 'pdf_document',
  news: 'news',
};

function mineSnippetFacts(result: SerpResult, base: {
  sourceUrl: string;
  sourceTitle: string;
  evidenceText?: string;
  query: string;
  domain: string;
}): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const text = `${result.title}. ${result.snippet ?? ''}`.replace(/\s+/g, ' ').trim();
  if (!text) return evidence;

  const push = (field: EvidenceField, value: string, confidence: number, metadata?: Record<string, unknown>) => {
    evidence.push(
      makeEvidence({
        ...base,
        field,
        value: value.trim(),
        sourceType: 'search_result',
        extractedBy: 'serp',
        confidence,
        metadata,
      }),
    );
  };

  const founded = text.match(/\b(?:founded|established|since|fundad[ao]|desde)\D{0,24}((?:19|20)\d{2})\b/i);
  if (founded?.[1]) push('founding_year', founded[1], 0.55);

  const employees = text.match(/\b(\d{1,3}(?:,\d{3})?|\d+\+)\s+(?:employees|empleados|workers)\b/i);
  if (employees?.[0]) push('employee_count', employees[0], 0.5);

  const role = text.match(/\b(CEO|Founder|Co-?founder|Director(?: General)?|President|Gerente General)\b/i);
  const name = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/);
  if (role && name && /CEO|founder|director|leadership|team|management|linkedin\.com\/in/i.test(result.query)) {
    push('key_person', name[1]!, 0.5, { role: role[0] });
  }

  if (/ISO\s?\d{4,5}|COFEPRIS|FDA|CE mark/i.test(text)) {
    const cert = text.match(/ISO\s?\d{4,5}(?::\d{4})?|COFEPRIS|FDA|CE mark/i)?.[0];
    if (cert) push('certification', cert, 0.55);
  }

  if (/product|producto|service|servicio|catalog|catalogo|brochure/i.test(result.query)) {
    const snippet = (result.snippet ?? result.title).slice(0, 180);
    if (snippet.length > 20) push('products_services', snippet, 0.48);
  }

  if (result.intent === 'news_history') {
    push('history_event', text.slice(0, 180), 0.5);
  }

  return evidence;
}

/**
 * Deterministic SERP mining: social/PDF/news URLs in results become evidence
 * IMMEDIATELY — no AI involved. Official-candidate domains feed the resolver.
 */
export function mineSerpResults(results: SerpResult[]): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  for (const result of results) {
    if (!result.url) continue;
    const urlClass = classifyUrl(result.url);
    let domain = '';
    try {
      domain = new URL(result.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }

    const base = {
      sourceUrl: result.url,
      sourceTitle: result.title,
      evidenceText: result.snippet,
      query: result.query,
      domain,
    } as const;

    evidence.push(...mineSnippetFacts(result, base));

    const socialOrDoc = CLASS_TO_FIELD[urlClass];
    if (socialOrDoc) {
      evidence.push(
        makeEvidence({
          ...base,
          field: socialOrDoc,
          value: result.url,
          sourceType: urlClass === 'news' ? 'news' : urlClass === 'pdf' ? 'search_result' : 'social',
          extractedBy: 'serp',
          confidence: Math.max(0.5, 0.8 - (result.rank - 1) * 0.05),
        }),
      );
      continue;
    }

    if (urlClass === 'linkedin_person') {
      const parsed = parseLinkedInTitle(result.title);
      if (parsed) {
        evidence.push(
          makeEvidence({
            ...base,
            field: 'key_person',
            value: parsed.name,
            sourceType: 'social',
            extractedBy: 'serp',
            confidence: 0.6,
            evidenceText: result.title,
            metadata: { linkedinProfile: result.url.replace(/\/$/, ''), role: parsed.role },
          }),
        );
      }
      continue;
    }

    if (urlClass === 'official_candidate') {
      evidence.push(
        makeEvidence({
          ...base,
          field: 'alternative_domain',
          value: domain,
          sourceType: 'search_result',
          extractedBy: 'serp',
          confidence: Math.max(0.3, 0.65 - (result.rank - 1) * 0.06),
          metadata: { rank: result.rank, intent: result.intent },
        }),
      );
    }

    if (urlClass === 'directory' || urlClass === 'registry') {
      // Surface the profile LINK itself — for companies without a website
      // these directory/trade-data profiles are the only public trail, and
      // the report should hand the user somewhere to click.
      evidence.push(
        makeEvidence({
          ...base,
          field: 'source_url',
          value: result.url,
          sourceType: urlClass === 'registry' ? 'public_registry' : 'third_party_directory',
          extractedBy: 'serp',
          confidence: urlClass === 'registry' ? 0.6 : 0.5,
          evidenceText: (result.snippet ?? result.title).slice(0, 200),
          metadata: { urlClass, profileFor: result.title.slice(0, 80) },
        }),
      );

      // Mexican RFC (tax ID) often appears verbatim in trade-data URLs and
      // snippets, e.g. veritradecorp.com/.../rfc-vic090710iu3
      const rfcHaystack = `${result.url} ${result.title} ${result.snippet ?? ''}`;
      const rfcMatch = rfcHaystack.match(/rfc[-_/:\s]*([a-zñ&]{3,4}\d{6}[a-z0-9]{3})\b/i);
      if (rfcMatch?.[1]) {
        evidence.push(
          makeEvidence({
            ...base,
            field: 'tax_id',
            value: `RFC ${rfcMatch[1].toUpperCase()}`,
            sourceType: urlClass === 'registry' ? 'public_registry' : 'third_party_directory',
            extractedBy: 'regex',
            confidence: 0.7,
            evidenceText: `RFC found in ${urlClass} result: ${result.url.slice(0, 120)}`,
          }),
        );
      }
    }
  }

  return evidence;
}
