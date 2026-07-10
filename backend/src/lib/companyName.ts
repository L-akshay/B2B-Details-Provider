/**
 * Users paste full legal names ("BIOADVANCE DISPOSITIVOS E INNOVACIONES
 * MEDICAS S.A. DE C.V. Mexico"); registries and search engines match far
 * better on the trade name. Strip legal-form suffixes and trailing country
 * words, and fix SHOUTING CASE.
 */

const LEGAL_SUFFIX_RE =
  /[,.]?\s+(s\.?\s?a\.?\s+de\s+c\.?\s?v\.?|s\.?a\.?p\.?i\.?\s+de\s+c\.?v\.?|s\.?\s+de\s+r\.?l\.?(\s+de\s+c\.?v\.?)?|sa\s+de\s+cv|inc(orporated)?|llc|l\.l\.c|ltd|limited|pvt\.?\s+ltd|private\s+limited|plc|gmbh\s*&\s*co\.?\s*kg|gmbh|a\.?g|b\.?v|n\.?v|s\.?a\.?s|s\.?a\.?r\.?l|s\.?r\.?l|s\.?p\.?a|pty\.?\s+ltd|co\.?,?\s+ltd|corp(oration)?|company|pbc|k\.?k|oyj?|a\/s|ab|s\.?a)\.?\s*$/i;

const COUNTRY_TAIL_RE =
  /\s+(m[eé]xico|mexico|india|usa|u\.s\.a\.?|united\s+states|uk|united\s+kingdom|germany|deutschland|france|spain|espa[nñ]a|italy|brazil|brasil|chile|argentina|colombia|peru|canada|australia|japan|china|singapore|uae|netherlands)\s*$/i;

export function simplifyCompanyName(raw: string): string {
  let name = raw.trim().replace(/\s+/g, ' ');
  let previous: string;
  do {
    previous = name;
    name = name.replace(COUNTRY_TAIL_RE, '').trim();
    name = name.replace(LEGAL_SUFFIX_RE, '').trim();
    name = name.replace(/[,;.]+$/, '').trim();
  } while (name !== previous && name.length > 2);

  if (name.length < 2) return raw.trim();

  // ALL-CAPS legal names read poorly and can hurt entity search
  if (name === name.toUpperCase() && /[A-Z]{4,}/.test(name)) {
    name = name.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
  }
  return name;
}
