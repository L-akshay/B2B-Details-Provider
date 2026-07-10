import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { makeEvidence, type EvidenceItem, type SerpResult } from './types';
import { publicFetch } from './public-fetch';

const MAX_PDF_BYTES = (Number(process.env.PDF_MAX_MB) || 15) * 1024 * 1024;
const MAX_PDFS = 6;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const CERT_RE = /\b(ISO\s?\d{4,5}(?::\d{4})?|NOM-\d+|CE\s?mark|FDA|COFEPRIS|FSC|GMP)\b/gi;
const YEAR_RE = /\b(19|20)\d{2}\b/g;
const LEGAL_RE = /\b([A-Z][A-Z0-9&.,\s-]{6,}S\.?A\.?(?:\s+DE\s+C\.?V\.?)?)\b/g;
const ADDRESS_RE = /(?:Address|Direccion|Dirección|Domicilio|Ubicacion|Ubicación|Oficina)[:\s]+(.{20,180})/gi;
const PRODUCT_LINE_RE = /(?:Products?|Productos?|Services?|Servicios?|Catalogo|Catálogo)[:\s]+(.{20,220})/gi;
const PERSON_ROLE_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-,]\s*(CEO|Founder|Director|Director General|Gerente General|President)\b/g;

// Lazy import keeps pdf-parse's debug-mode file access out of module load.
async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod = (await import('pdf-parse')) as unknown as {
    default: (data: Buffer) => Promise<{ text: string }>;
  };
  const parsed = await mod.default(buffer);
  return parsed.text ?? '';
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    return await withRetry(
      async (signal) => {
        const response = await publicFetch(url, { signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
        const type = response.headers.get('content-type') ?? '';
        if (!/pdf/i.test(type) && !url.toLowerCase().endsWith('.pdf')) {
          throw new Error('not a PDF');
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > MAX_PDF_BYTES) throw new Error(`PDF too large (${length} bytes)`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_PDF_BYTES) throw new Error('PDF exceeds size limit');
        return buffer;
      },
      { service: 'pdf-download', timeoutMs: 30_000, retries: 0 },
    );
  } catch {
    return null;
  }
}

/**
 * Downloads and text-mines public PDFs (brochures, catalogs, privacy
 * notices) found by the crawler and PDF search queries. Extracts emails,
 * certifications, founding-year hints as evidence with sourceUrl = the PDF.
 */
export async function minePublicPdfs(
  crawlPdfLinks: string[],
  serpResults: SerpResult[],
): Promise<EvidenceItem[]> {
  const fromSerp = serpResults.filter((r) => r.url.toLowerCase().endsWith('.pdf')).map((r) => r.url);
  const urls = [...new Set([...crawlPdfLinks, ...fromSerp])].slice(0, MAX_PDFS);
  const evidence: EvidenceItem[] = [];

  for (const url of urls) {
    // The PDF's existence is itself evidence (a public document).
    evidence.push(
      makeEvidence({
        field: 'pdf_document',
        value: url,
        sourceUrl: url,
        sourceType: 'official_pdf',
        extractedBy: 'serp',
        confidence: 0.7,
        sourceTitle: url.split('/').pop(),
      }),
    );

    const buffer = await downloadPdf(url);
    if (!buffer) continue;
    let text: string;
    try {
      text = (await extractPdfText(buffer)).slice(0, 40_000);
    } catch (err) {
      logger.warn({ url, err: String(err) }, 'pdf parse failed');
      continue;
    }

    const seen = new Set<string>();
    for (const match of text.matchAll(EMAIL_RE)) {
      const email = match[0].toLowerCase();
      if (seen.has(email) || /example|test|\.(png|jpg)$/i.test(email)) continue;
      seen.add(email);
      evidence.push(
        makeEvidence({
          field: 'email',
          value: email,
          normalizedValue: email,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.8,
        }),
      );
    }
    for (const match of text.matchAll(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}\b/g)) {
      const parsed = parsePhoneNumberFromString(match[0], 'MX');
      if (!parsed?.isValid()) continue;
      if (seen.has(parsed.number)) continue;
      seen.add(parsed.number);
      evidence.push(
        makeEvidence({
          field: 'phone',
          value: parsed.formatInternational(),
          normalizedValue: parsed.number,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.75,
        }),
      );
    }
    for (const match of text.matchAll(CERT_RE)) {
      const cert = match[0].toUpperCase().replace(/\s+/g, ' ');
      if (seen.has(`cert:${cert}`)) continue;
      seen.add(`cert:${cert}`);
      evidence.push(
        makeEvidence({
          field: 'certification',
          value: cert,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.8,
        }),
      );
    }
    for (const match of text.matchAll(LEGAL_RE)) {
      const legal = match[1]!.replace(/\s+/g, ' ').trim();
      if (seen.has(`legal:${legal}`)) continue;
      seen.add(`legal:${legal}`);
      evidence.push(
        makeEvidence({
          field: 'legal_name',
          value: legal,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.75,
          evidenceText: match[0],
        }),
      );
    }
    for (const match of text.matchAll(ADDRESS_RE)) {
      const address = match[1]!.replace(/\s+/g, ' ').trim();
      // require a street token + postal/place signal so product/marketing
      // text after a "Dirección:" cue isn't mistaken for an address
      const isAddress =
        /\b(av\.?|avenida|calle|blvd\.?|boulevard|carretera|street|road|suite|piso|col\.?|colonia|c\.?p\.?|#)\b/i.test(address) &&
        /\b\d{4,6}\b|m[eé]xico|cdmx|jalisco|guadalajara|buenos aires|chile|santiago|usa|madrid/i.test(address);
      if (!isAddress || seen.has(`addr:${address.toLowerCase()}`)) continue;
      seen.add(`addr:${address.toLowerCase()}`);
      evidence.push(
        makeEvidence({
          field: 'address',
          value: address,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.7,
          evidenceText: match[0],
        }),
      );
    }
    for (const match of text.matchAll(PRODUCT_LINE_RE)) {
      const line = match[1]!.replace(/\s+/g, ' ').trim();
      if (seen.has(`prod:${line.toLowerCase()}`)) continue;
      seen.add(`prod:${line.toLowerCase()}`);
      evidence.push(
        makeEvidence({
          field: 'products_services',
          value: line.slice(0, 220),
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.65,
          evidenceText: match[0].slice(0, 260),
        }),
      );
    }
    for (const match of text.matchAll(PERSON_ROLE_RE)) {
      const name = match[1]!;
      const role = match[2]!;
      if (seen.has(`person:${name.toLowerCase()}`)) continue;
      seen.add(`person:${name.toLowerCase()}`);
      evidence.push(
        makeEvidence({
          field: 'key_person',
          value: name,
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.65,
          evidenceText: match[0],
          metadata: { role },
        }),
      );
    }
    // Founding-year hint: earliest plausible year mentioned near "fund"/"desde"
    const foundedContext = text.match(/(?:founded|fundad[ao]|desde|established|since)[^\d]{0,20}((?:19|20)\d{2})/i);
    if (foundedContext?.[1]) {
      evidence.push(
        makeEvidence({
          field: 'founding_year',
          value: foundedContext[1],
          sourceUrl: url,
          sourceType: 'official_pdf',
          extractedBy: 'pdf_parser',
          confidence: 0.65,
          evidenceText: foundedContext[0],
        }),
      );
    }
    void YEAR_RE;
  }

  logger.info({ pdfs: urls.length, evidence: evidence.length }, 'pdf mining complete');
  return evidence;
}
