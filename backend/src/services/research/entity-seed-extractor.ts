import type { CrawledPage, EvidenceItem } from './types';

/**
 * Expansion seeds mined from round-0 evidence. These feed the follow-up query
 * generator: a discovered legal name, social handle, or product name unlocks
 * far more precise searches than the raw company name ever could.
 * Deterministic (regex + field mapping) — no AI.
 */
export interface EntitySeeds {
  legalNames: string[];
  brandNames: string[];
  domains: string[];
  socialHandles: string[];
  peopleNames: string[];
  productNames: string[];
  partnerNames: string[];
  certificationNames: string[];
  cities: string[];
  countries: string[];
  emailDomains: string[];
}

const HANDLE_RE =
  /(?:instagram\.com|facebook\.com|tiktok\.com|x\.com|twitter\.com)\/(@?[\w.-]{3,40})|youtube\.com\/(?:c\/|channel\/|@)([\w.-]{3,40})|linkedin\.com\/company\/([\w-]{3,60})/i;

const GENERIC_HANDLES = /^(home|about|contact|share|watch|explore|p|reel|company|pages?|profile)$/i;

const CITY_HINTS =
  /\b(Guadalajara|Ciudad de M[eé]xico|CDMX|Monterrey|Buenos Aires|Santiago|Bogot[aá]|Lima|Madrid|Barcelona|London|New York|San Francisco|Miami|Toronto|S[aã]o Paulo|Mexico City|Quer[eé]taro|Tijuana|Delhi|Mumbai|Bangalore|Singapore|Dubai)\b/gi;

function pushUnique(list: string[], value: string | undefined | null, max = 10): void {
  const v = value?.trim();
  if (!v || v.length < 2) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  if (list.length >= max) return;
  list.push(v);
}

export function extractEntitySeeds(
  companyName: string,
  evidence: EvidenceItem[],
  pages: CrawledPage[],
): EntitySeeds {
  const seeds: EntitySeeds = {
    legalNames: [],
    brandNames: [],
    domains: [],
    socialHandles: [],
    peopleNames: [],
    productNames: [],
    partnerNames: [],
    certificationNames: [],
    cities: [],
    countries: [],
    emailDomains: [],
  };

  for (const item of evidence) {
    switch (item.field) {
      case 'legal_name':
        pushUnique(seeds.legalNames, item.value, 4);
        break;
      case 'brand_name':
        pushUnique(seeds.brandNames, item.value, 4);
        break;
      case 'official_website':
      case 'alternative_domain': {
        const domain = item.domain ?? item.value.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
        pushUnique(seeds.domains, domain, 6);
        break;
      }
      case 'linkedin':
      case 'instagram':
      case 'facebook':
      case 'youtube':
      case 'x_twitter':
      case 'tiktok': {
        const m = item.value.match(HANDLE_RE);
        const handle = (m?.[1] ?? m?.[2] ?? m?.[3])?.replace(/^@/, '');
        if (handle && !GENERIC_HANDLES.test(handle)) pushUnique(seeds.socialHandles, handle, 6);
        break;
      }
      case 'key_person':
        pushUnique(seeds.peopleNames, item.value, 8);
        break;
      case 'products_services':
        // only concrete short product names make good queries
        if (item.value.length <= 60) pushUnique(seeds.productNames, item.value, 10);
        break;
      case 'client_partner':
      case 'distributor':
      case 'supplier':
        pushUnique(seeds.partnerNames, item.value, 8);
        break;
      case 'certification':
        pushUnique(seeds.certificationNames, item.value, 6);
        break;
      case 'jurisdiction':
        pushUnique(seeds.countries, item.value, 4);
        break;
      case 'email': {
        const dom = item.value.split('@')[1];
        if (dom && !/gmail|hotmail|outlook|yahoo|proton/i.test(dom)) pushUnique(seeds.emailDomains, dom, 4);
        break;
      }
      case 'address':
        for (const m of item.value.matchAll(CITY_HINTS)) pushUnique(seeds.cities, m[0], 8);
        break;
      default:
        break;
    }
  }

  // Brand aliases from page titles ("Bioadvance - Dispositivos Médicos" → "Bioadvance")
  for (const page of pages.slice(0, 10)) {
    const alias = page.title.split(/\s*[-|–]\s*/)[0]?.trim();
    if (alias && alias.length >= 3 && alias.length <= 40 && alias.toLowerCase() !== companyName.toLowerCase()) {
      pushUnique(seeds.brandNames, alias, 4);
    }
    for (const m of page.text.slice(0, 5_000).matchAll(CITY_HINTS)) pushUnique(seeds.cities, m[0], 8);
  }

  // Email domains are strong alternative-domain candidates
  for (const dom of seeds.emailDomains) pushUnique(seeds.domains, dom, 6);

  return seeds;
}

/** Flatten seeds for debug output. */
export function seedsSummary(seeds: EntitySeeds): Record<string, string[]> {
  return Object.fromEntries(Object.entries(seeds).filter(([, v]) => (v as string[]).length > 0)) as Record<
    string,
    string[]
  >;
}
