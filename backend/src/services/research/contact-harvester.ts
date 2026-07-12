import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { makeEvidence, type CrawledPage, type EvidenceItem, type SourceType } from './types';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;

// Sites hide addresses from naive scrapers as "info [at] company dot com",
// "ventas (arroba) company punto mx", or "info @ company . com". These are
// still PUBLIC — the human-readable page shows them — so reconstruct them.
// "at" tokens: @, or (at)/[at]/{at}/at/arroba with optional surrounding brackets
const AT = String.raw`(?:@|[[({]\s*(?:at|arroba)\s*[)\]}]|\b(?:at|arroba)\b)`;
const DOT = String.raw`(?:\.|[[({]\s*(?:dot|punto)\s*[)\]}]|\b(?:dot|punto)\b)`;
const OBFUSCATED_EMAIL_RE = new RegExp(
  String.raw`([a-z0-9._%+-]{2,})\s*${AT}\s*([a-z0-9.-]{2,})\s*${DOT}\s*([a-z]{2,})(?:\s*${DOT}\s*([a-z]{2,}))?`,
  'gi',
);

function deobfuscateEmails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(OBFUSCATED_EMAIL_RE)) {
    // skip normal emails (already caught by EMAIL_RE) — only keep spaced/bracketed forms
    if (/^\S+@\S+\.\S+$/.test(m[0].replace(/\s+/g, '')) && !/\[|\(|\barroba\b|\bpunto\b|\bdot\b|\bat\b/i.test(m[0])) {
      if (!/\s/.test(m[0])) continue;
    }
    const email = `${m[1]}@${m[2]}.${m[3]}${m[4] ? `.${m[4]}` : ''}`.toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z.]{2,}$/.test(email)) out.push(email);
  }
  return out;
}
const TEL_RE = /href=["']tel:([+0-9()\s.\-]{7,20})["']/gi;
const WHATSAPP_RE = /https?:\/\/(?:wa\.me\/[0-9+]+|(?:api\.)?whatsapp\.com\/send[^"'\s<>]*)/gi;
const VISIBLE_PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}\b/g;

const JUNK_EMAIL_RE =
  /@(example|test|sentry|wixpress|yourdomain|domain|email)\.|\.(png|jpe?g|gif|svg|webp|css|js)$|@[0-9]+x\.|^(user|name|email|correo)@/i;

const DEPARTMENT_HINTS: Array<[RegExp, string]> = [
  [/ventas|sales/i, 'sales'],
  [/soporte|support|ayuda/i, 'support'],
  [/legal|privacidad|privacy/i, 'legal'],
  [/postventa/i, 'after-sales'],
  [/contacto|contact|info|hola|hello/i, 'general'],
  [/rh|hr|recursos|careers|talento/i, 'hr'],
];

// Street tokens must be unambiguous — bare "no" (Spanish "no") and "#" match
// prose, so require "No. <num>" / "# <num>" forms instead.
const STREET_TOKEN = String.raw`(?:av\.|avenida|calle|blvd\.?|boulevard|carretera|street|road|suite|piso|colonia|no\.\s*\d|#\s*\d)`;
const ADDRESS_SHAPE_RE = new RegExp(
  String.raw`\b${STREET_TOKEN}\b[\s\S]{10,180}?(?:\b\d{4,6}\b|m[eé]xico|cdmx|jalisco|guadalajara|nuevo le[oó]n|buenos aires|chile|santiago|usa|spain)`,
  'gi',
);

function pageSourceType(page: CrawledPage): SourceType {
  return page.source === 'firecrawl' ? 'firecrawl' : 'official_website';
}

function emailConfidence(page: CrawledPage): number {
  if (page.kind === 'contact' || page.kind === 'legal') return 0.95;
  if (page.kind === 'home') return 0.9;
  return 0.85;
}

function departmentFor(email: string): string | undefined {
  const local = email.split('@')[0] ?? '';
  return DEPARTMENT_HINTS.find(([re]) => re.test(local))?.[1];
}

function looksLikePlaceholderPhone(digits: string): boolean {
  if (/(\d)\1{5,}/.test(digits)) return true;
  if (/1234567|2345678|9876543/.test(digits)) return true;
  return false;
}

/**
 * Fully deterministic contact extraction: regex + link parsing over crawled
 * pages, phone validation via libphonenumber, placeholder rejection, and
 * page-kind-based confidence. No AI anywhere in this path.
 */
export function harvestContacts(pages: CrawledPage[], defaultRegion = 'MX'): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const seenWhatsapp = new Set<string>();
  const seenForms = new Set<string>();
  const seenAddresses = new Set<string>();

  for (const page of pages) {
    const sourceType = pageSourceType(page);
    const base = { sourceUrl: page.finalUrl, sourceTitle: page.title, pageUrl: page.finalUrl, sourceType } as const;

    // emails: mailto first (strongest), then raw text, then de-obfuscated forms
    const emailCandidates = new Set<string>();
    for (const match of page.html.matchAll(MAILTO_RE)) emailCandidates.add(match[1]!.toLowerCase());
    for (const match of `${page.text}\n${page.html}`.matchAll(EMAIL_RE)) {
      emailCandidates.add(match[0].toLowerCase());
    }
    for (const email of deobfuscateEmails(page.text)) emailCandidates.add(email);
    for (const email of emailCandidates) {
      if (JUNK_EMAIL_RE.test(email) || seenEmails.has(email)) continue;
      if (/^no-?reply@/.test(email)) continue;
      seenEmails.add(email);
      const idx = page.text.toLowerCase().indexOf(email);
      evidence.push(
        makeEvidence({
          ...base,
          field: 'email',
          value: email,
          normalizedValue: email,
          extractedBy: 'regex',
          confidence: emailConfidence(page),
          evidenceText: idx >= 0 ? page.text.slice(Math.max(0, idx - 80), idx + email.length + 40) : undefined,
          metadata: { department: departmentFor(email) },
        }),
      );
    }

    // phones: tel: links (strong) + visible text patterns (validated)
    const phoneCandidates: Array<{ raw: string; strong: boolean }> = [];
    for (const match of page.html.matchAll(TEL_RE)) phoneCandidates.push({ raw: match[1]!, strong: true });
    if (['contact', 'home', 'legal', 'about', 'team'].includes(page.kind)) {
      for (const match of page.text.matchAll(VISIBLE_PHONE_RE)) {
        phoneCandidates.push({ raw: match[0], strong: false });
      }
    }
    for (const { raw, strong } of phoneCandidates) {
      const parsed = parsePhoneNumberFromString(raw, defaultRegion as never);
      if (!parsed || !parsed.isValid()) continue;
      const e164 = parsed.number;
      if (seenPhones.has(e164)) continue;
      const digits = e164.replace(/\D/g, '');
      const placeholder = looksLikePlaceholderPhone(digits);
      if (placeholder && !strong) continue;
      seenPhones.add(e164);
      const idx = page.text.indexOf(raw);
      evidence.push(
        makeEvidence({
          ...base,
          field: 'phone',
          value: parsed.formatInternational(),
          normalizedValue: e164,
          extractedBy: strong ? 'cheerio' : 'regex',
          confidence: placeholder ? 0.35 : strong ? 0.95 : page.kind === 'contact' ? 0.85 : 0.7,
          verified: placeholder ? 'low_confidence' : 'unverified',
          evidenceText: idx >= 0 ? page.text.slice(Math.max(0, idx - 80), idx + raw.length + 40) : undefined,
        }),
      );
    }

    // WhatsApp deep links
    for (const match of page.html.matchAll(WHATSAPP_RE)) {
      const url = match[0];
      if (seenWhatsapp.has(url)) continue;
      seenWhatsapp.add(url);
      evidence.push(
        makeEvidence({
          ...base,
          field: 'whatsapp',
          value: url,
          extractedBy: 'regex',
          confidence: 0.9,
        }),
      );
    }

    // contact form URLs
    if (/(action=["'][^"']*contact|<form[\s\S]{0,400}?(contact|contacto|mensaje|message))/i.test(page.html)) {
      if (!seenForms.has(page.finalUrl)) {
        seenForms.add(page.finalUrl);
        evidence.push(
          makeEvidence({
            ...base,
            field: 'contact_form',
            value: page.finalUrl,
            extractedBy: 'cheerio',
            confidence: page.kind === 'contact' ? 0.9 : 0.7,
          }),
        );
      }
    }

    // addresses: cue-labelled blocks + address-shaped text on strong pages.
    // A real address has a street token AND a postal/place signal — this
    // rejects product descriptions that happen to sit near a "Dirección" cue.
    const looksLikeAddress = (t: string): boolean =>
      new RegExp(String.raw`\b${STREET_TOKEN}\b`, 'i').test(t) &&
      /\b\d{4,6}\b|m[eé]xico|cdmx|jalisco|guadalajara|nuevo le[oó]n|buenos aires|chile|santiago|usa|spain/i.test(t);
    if (['contact', 'legal', 'home', 'about'].includes(page.kind)) {
      const addressTexts = new Set<string>();
      // Inline shape matching only — the address must itself contain a street
      // token AND a postal/place signal. (A looser "text after a Dirección:
      // label" branch was dropped because it swept in adjacent product text.)
      for (const match of page.text.matchAll(ADDRESS_SHAPE_RE)) {
        const t = match[0].replace(/\s+/g, ' ').trim();
        if (looksLikeAddress(t)) addressTexts.add(t);
      }
      for (const address of addressTexts) {
        const key = address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (seenAddresses.has(key)) continue;
        seenAddresses.add(key);
        evidence.push(
          makeEvidence({
            ...base,
            field: 'address',
            value: address,
            extractedBy: 'regex',
            confidence: page.kind === 'contact' || page.kind === 'legal' ? 0.8 : 0.6,
            evidenceText: address,
          }),
        );
      }
    }
  }

  return evidence;
}
