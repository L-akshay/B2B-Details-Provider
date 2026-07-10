import { resolveMx } from 'node:dns/promises';
import { logger } from '../lib/logger';
import type { EmailRecord, PhoneRecord } from '../types/schema';
import type { ScrapedPage } from './firecrawl';

export interface HarvestedContacts {
  emails: EmailRecord[];
  phones: PhoneRecord[];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Phones must be explicit tel: links or international format — bare digit
// runs on web pages are overwhelmingly noise (IDs, dates, prices).
const TEL_HREF_RE = /href=["']tel:([+0-9()\s.-]{7,20})["']/gi;
const INTL_PHONE_RE = /\+\d[\d\s().-]{7,17}\d/g;

const JUNK_EMAIL_RE =
  /@(example|test|sentry|wixpress|sentry-next)\.|\.(png|jpe?g|gif|svg|webp|css|js)$|@[0-9]+x\./i;

const mxCache = new Map<string, boolean>();

async function domainAcceptsMail(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const records = await resolveMx(domain);
    result = records.length > 0;
  } catch {
    result = false;
  }
  mxCache.set(domain, result);
  return result;
}

function normalizePhone(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic contact harvesting from scraped pages (replaces Hunter.io).
 * Emails are validated against live MX records so `verified: true` means the
 * mail domain actually accepts email — the AI passes are instructed to never
 * add emails beyond this list, which makes hallucinated emails impossible.
 */
export async function harvestContacts(
  pages: ScrapedPage[],
  homepageHtml: string | null,
): Promise<HarvestedContacts> {
  const emailSources = new Map<string, string>();
  const phoneSources = new Map<string, { value: string; sourceUrl: string }>();

  const documents = pages.map((page) => ({ url: page.url, text: page.markdown }));
  if (homepageHtml && pages[0]) {
    documents.push({ url: pages[0].url, text: homepageHtml });
  }

  for (const doc of documents) {
    for (const match of doc.text.matchAll(EMAIL_RE)) {
      const email = match[0].toLowerCase();
      if (JUNK_EMAIL_RE.test(email)) continue;
      if (!emailSources.has(email)) emailSources.set(email, doc.url);
    }

    const phoneMatches = [
      ...[...doc.text.matchAll(TEL_HREF_RE)].map((m) => m[1] ?? ''),
      ...[...doc.text.matchAll(INTL_PHONE_RE)].map((m) => m[0]),
    ];
    for (const raw of phoneMatches) {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) continue;
      if (!phoneSources.has(digits)) {
        phoneSources.set(digits, { value: normalizePhone(raw), sourceUrl: doc.url });
      }
    }
  }

  const emails: EmailRecord[] = [];
  for (const [email, sourceUrl] of emailSources) {
    const mailDomain = email.split('@')[1];
    const verified = mailDomain ? await domainAcceptsMail(mailDomain) : false;
    emails.push({ value: email, verified, source: sourceUrl });
  }

  const phones: PhoneRecord[] = [...phoneSources.values()].map((phone) => ({
    value: phone.value,
    source_url: phone.sourceUrl,
  }));

  logger.info({ emails: emails.length, phones: phones.length }, 'contact harvest complete');
  return { emails, phones };
}
