import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { makeEvidence, type EvidenceItem } from './types';

/**
 * SEC EDGAR full-text company search (free public API, no key). Only routed
 * for companies with US signals. Uses the official JSON endpoints with the
 * User-Agent the SEC requires; one search + one submissions fetch per job,
 * far below their rate limits.
 */

const SEC_UA = 'company-research-tool admin@example.com (public research)';

interface EdgarHit {
  cik_str?: number;
  ticker?: string;
  title?: string;
}

async function secJson<T>(url: string): Promise<T> {
  return withRetry(
    async (signal) => {
      const res = await fetch(url, { signal, headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
      return (await res.json()) as T;
    },
    { service: 'sec-edgar', timeoutMs: 20_000, retries: 1 },
  );
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\b(inc|corp|co|ltd|llc|plc|the)\b/g, '').replace(/[^a-z0-9]/g, '');
}

export async function querySecEdgar(companyName: string): Promise<{ evidence: EvidenceItem[]; errors: Record<string, string> }> {
  const evidence: EvidenceItem[] = [];
  const errors: Record<string, string> = {};

  try {
    // company_tickers.json is the SEC's official name→CIK mapping
    const tickers = await secJson<Record<string, EdgarHit>>('https://www.sec.gov/files/company_tickers.json');
    const target = normalizeName(companyName);
    if (target.length < 4) return { evidence, errors };

    const match = Object.values(tickers).find((t) => {
      const n = normalizeName(t.title ?? '');
      return n.length >= 4 && (n === target || n.startsWith(target) || target.startsWith(n));
    });
    if (!match?.cik_str) {
      return { evidence, errors }; // not an SEC registrant — normal for most companies
    }

    const cik = String(match.cik_str).padStart(10, '0');
    const srcUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
    const sub = await secJson<{
      name?: string;
      sicDescription?: string;
      tickers?: string[];
      addresses?: { business?: { street1?: string; city?: string; stateOrCountry?: string; zipCode?: string } };
      formerNames?: Array<{ name?: string }>;
      filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[] } };
    }>(`https://data.sec.gov/submissions/CIK${cik}.json`);

    const push = (field: EvidenceItem['field'], value: string, confidence = 0.9, meta?: Record<string, unknown>) => {
      if (!value?.trim()) return;
      evidence.push(
        makeEvidence({
          field,
          value: value.trim(),
          sourceUrl: srcUrl,
          sourceTitle: `SEC EDGAR: ${sub.name ?? companyName}`,
          sourceType: 'sec_edgar',
          extractedBy: 'api',
          confidence,
          metadata: meta,
        }),
      );
    };

    push('legal_name', sub.name ?? '', 0.95);
    push('registration_id', `SEC CIK ${cik}`, 0.95);
    push('industry', sub.sicDescription ?? '', 0.85);
    if (sub.tickers?.[0]) push('funding_financials', `Publicly traded (ticker: ${sub.tickers.join(', ')})`, 0.9);
    const addr = sub.addresses?.business;
    if (addr?.street1) {
      push('address', [addr.street1, addr.city, addr.stateOrCountry, addr.zipCode].filter(Boolean).join(', '), 0.9);
    }
    for (const former of (sub.formerNames ?? []).slice(0, 3)) {
      if (former.name) push('brand_name', former.name, 0.7, { formerName: true });
    }
    const recent = sub.filings?.recent;
    for (let i = 0; i < Math.min(3, recent?.form?.length ?? 0); i++) {
      const form = recent!.form![i];
      const date = recent!.filingDate![i];
      if (form && /10-K|10-Q|8-K|S-1/.test(form)) {
        push('news', `SEC filing ${form} (${date})`, 0.85, { date });
      }
    }

    logger.info({ cik, evidence: evidence.length }, 'sec edgar complete');
  } catch (err) {
    errors['sec_edgar'] = String(err);
  }
  return { evidence, errors };
}
