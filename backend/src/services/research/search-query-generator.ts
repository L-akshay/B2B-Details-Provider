export interface GeneratedQuery {
  intent:
    | 'official_website'
    | 'contact'
    | 'social'
    | 'people'
    | 'business'
    | 'documents'
    | 'news_history'
    | 'competitors';
  query: string;
  /** Higher runs first when the SERP budget is limited */
  priority: number;
}

export interface QueryGeneratorInput {
  companyName: string;
  country?: string;
  domain?: string;
  industry?: string;
  languageHints?: string[];
}

export interface GroupedSearchQueries {
  grouped: Record<GeneratedQuery['intent'], GeneratedQuery[]>;
  flat: GeneratedQuery[];
}

/**
 * Deterministic query fan-out (50-120 queries). Providers run these in
 * priority order until their budget runs out, so the highest-signal intents
 * (website, socials, contact) always execute.
 */
export function generateSearchQueries(input: QueryGeneratorInput): GeneratedQuery[] {
  const c = input.companyName.trim();
  const queries: GeneratedQuery[] = [];
  const add = (intent: GeneratedQuery['intent'], query: string, priority: number) =>
    queries.push({ intent, query, priority });

  // Official website
  add('official_website', `${c} official website`, 100);
  add('official_website', `${c} website`, 95);
  add('official_website', `${c} official site`, 92);
  add('official_website', `${c} homepage`, 88);
  add('official_website', `${c} contacto`, 82);
  add('official_website', `${c} contact`, 82);
  add('official_website', `${c} about`, 72);
  add('official_website', `${c} nosotros`, 70);
  add('official_website', `${c} acerca de`, 68);
  add('official_website', `${c} quienes somos`, 66);

  // Contact
  add('contact', `${c} email`, 88);
  add('contact', `${c} correo`, 78);
  add('contact', `${c} phone`, 78);
  add('contact', `${c} telefono`, 76);
  add('contact', `${c} contact number`, 75);
  add('contact', `${c} address`, 76);
  add('contact', `${c} direccion`, 74);
  add('contact', `${c} location`, 72);
  add('contact', `${c} ubicacion`, 70);
  add('contact', `${c} WhatsApp`, 68);
  add('contact', `${c} contact form`, 66);
  add('contact', `${c} privacy policy`, 64);
  add('contact', `${c} aviso de privacidad`, 64);

  // Social
  add('social', `${c} LinkedIn`, 92);
  add('social', `${c} site:linkedin.com/company`, 90);
  add('social', `${c} Instagram`, 84);
  add('social', `${c} site:instagram.com`, 80);
  add('social', `${c} Facebook`, 84);
  add('social', `${c} site:facebook.com`, 80);
  add('social', `${c} YouTube`, 78);
  add('social', `${c} site:youtube.com`, 74);
  add('social', `${c} Twitter`, 66);
  add('social', `${c} X`, 64);
  add('social', `${c} X Twitter`, 64);
  add('social', `${c} TikTok`, 62);

  // People
  add('people', `${c} CEO`, 84);
  add('people', `${c} founder`, 82);
  add('people', `${c} cofounder`, 80);
  add('people', `${c} director`, 70);
  add('people', `${c} director general`, 70);
  add('people', `${c} leadership`, 68);
  add('people', `${c} team`, 68);
  add('people', `${c} management`, 66);
  add('people', `site:linkedin.com/in "${c}"`, 79);

  // Business details
  add('business', `${c} products`, 72);
  add('business', `${c} productos`, 70);
  add('business', `${c} services`, 70);
  add('business', `${c} servicios`, 68);
  add('business', `${c} catalog`, 64);
  add('business', `${c} catalogo`, 63);
  add('business', `${c} brochure`, 62);
  add('business', `${c} clients`, 60);
  add('business', `${c} customers`, 60);
  add('business', `${c} partners`, 59);
  add('business', `${c} distributors`, 57);
  add('business', `${c} awards`, 56);
  add('business', `${c} certification`, 56);
  add('business', `${c} ISO`, 55);
  add('business', `${c} funding`, 52);
  add('business', `${c} revenue`, 51);
  add('business', `${c} employee count`, 50);

  // Documents
  add('documents', `${c} filetype:pdf`, 61);
  add('documents', `${c} brochure filetype:pdf`, 52);
  add('documents', `${c} catalog filetype:pdf`, 51);
  add('documents', `${c} catalogo filetype:pdf`, 50);
  add('documents', `${c} privacy filetype:pdf`, 48);
  add('documents', `${c} aviso de privacidad filetype:pdf`, 48);
  add('documents', `${c} certificate filetype:pdf`, 46);
  add('documents', `${c} ISO filetype:pdf`, 46);
  add('documents', `${c} presentation filetype:pdf`, 44);

  // History / news
  add('news_history', `${c} news`, 69);
  add('news_history', `${c} noticias`, 60);
  add('news_history', `${c} press release`, 59);
  add('news_history', `${c} founded`, 64);
  add('news_history', `${c} founded year`, 54);
  add('news_history', `${c} history`, 53);
  add('news_history', `${c} historia`, 52);
  add('news_history', `${c} anniversary`, 48);
  add('news_history', `${c} aniversario`, 47);
  add('news_history', `${c} awards`, 46);
  add('news_history', `${c} expansion`, 44);
  add('news_history', `${c} new office`, 43);

  // Competitors
  add('competitors', `${c} competitors`, 55);
  add('competitors', `${c} alternatives`, 52);
  add('competitors', `companies similar to ${c}`, 50);
  if (input.industry) {
    add('competitors', `${input.industry} companies${input.country ? ` in ${input.country}` : ''}`, 47);
  }

  // B2B relationships (suppliers / buyers / distributors) — lead enrichment
  add('competitors', `${c} suppliers`, 46);
  add('competitors', `${c} proveedores`, 45);
  add('competitors', `${c} distributors`, 46);
  add('competitors', `${c} distribuidores`, 45);
  add('competitors', `${c} clients`, 44);
  add('competitors', `${c} customers`, 44);
  add('competitors', `${c} partners`, 44);
  add('competitors', `${c} authorized dealers`, 42);
  if (input.industry) {
    add('competitors', `${input.industry} suppliers${input.country ? ` in ${input.country}` : ''}`, 43);
    add('competitors', `${input.industry} distributors${input.country ? ` in ${input.country}` : ''}`, 43);
  }

  if (input.country) {
    add('official_website', `${c} ${input.country} official website`, 75);
    add('social', `${c} ${input.country} LinkedIn`, 72);
    add('contact', `${c} ${input.country} contact`, 68);
    add('contact', `${c} ${input.country} email`, 66);
    add('contact', `${c} ${input.country} address`, 65);
    add('contact', `${c} ${input.country} phone`, 64);
  }
  if (input.domain) {
    add('contact', `site:${input.domain} contact`, 88);
    add('official_website', `site:${input.domain} about OR nosotros`, 70);
    add('contact', `site:${input.domain} privacy OR "aviso de privacidad"`, 68);
    add('documents', `site:${input.domain} filetype:pdf`, 60);
  }

  const deduped = [...new Map(queries.map((query) => [query.query.toLowerCase(), query])).values()];
  return deduped.sort((a, b) => b.priority - a.priority);
}

export function generateGroupedSearchQueries(input: QueryGeneratorInput): GroupedSearchQueries {
  const flat = generateSearchQueries(input);
  const grouped = flat.reduce(
    (acc, query) => {
      acc[query.intent].push(query);
      return acc;
    },
    {
      official_website: [],
      contact: [],
      social: [],
      people: [],
      business: [],
      documents: [],
      news_history: [],
      competitors: [],
    } as Record<GeneratedQuery['intent'], GeneratedQuery[]>,
  );
  return { grouped, flat };
}
