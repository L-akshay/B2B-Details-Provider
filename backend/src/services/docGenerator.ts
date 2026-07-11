import PDFDocument from 'pdfkit';
import { getSupabase, REPORTS_BUCKET } from '../lib/supabaseClient';
import type { CompanyReport } from '../types/schema';
import type { MergedEvidence } from './research/evidence-deduper';
import type { ResearchDebug } from './research/types';

const PDF_MIME = 'application/pdf';
const NOT_AVAILABLE = 'Not publicly available';

const LINK = '#1d4ed8';
const MUTED = '#64748b';
const INK = '#0f172a';

type EvidenceAwareReport = CompanyReport & {
  evidence_sources?: Record<string, string[]>;
  low_confidence_evidence?: Array<{
    field: string;
    value: string;
    confidence: number;
    sourceUrls: string[];
  }>;
};

/**
 * Thin builder over pdfkit that mirrors the report's section/label/bullet
 * structure. pdfkit is pure JS (no native binaries), so it runs on Render
 * without extra system packages, and streams straight to a Buffer for upload.
 */
class ReportPdf {
  readonly doc: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<Buffer>;

  constructor() {
    this.doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    this.done = new Promise((resolve) => this.doc.on('end', () => resolve(Buffer.concat(this.chunks))));
  }

  title(text: string): void {
    this.doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(text);
    this.doc.moveDown(0.3);
  }

  subtitle(text: string): void {
    this.doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text(text);
    this.doc.moveDown(0.8);
  }

  heading(text: string): void {
    if (this.doc.y > this.doc.page.height - 120) this.doc.addPage();
    this.doc.moveDown(0.6);
    this.doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(text);
    const y = this.doc.y + 1;
    this.doc
      .moveTo(this.doc.page.margins.left, y)
      .lineTo(this.doc.page.width - this.doc.page.margins.right, y)
      .strokeColor('#e2e8f0')
      .lineWidth(1)
      .stroke();
    this.doc.moveDown(0.5);
  }

  paragraph(text: string): void {
    this.doc.fillColor(INK).font('Helvetica').fontSize(10).text(text, { align: 'left' });
    this.doc.moveDown(0.3);
  }

  /** "Label: value" line, value optional (falls back to Not publicly available). */
  labelValue(label: string, value?: string | null): void {
    this.doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
    this.doc.font('Helvetica').text(value && value.trim() ? value : NOT_AVAILABLE);
    this.doc.moveDown(0.15);
  }

  labelLink(label: string, url: string): void {
    this.doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
    this.doc.fillColor(LINK).font('Helvetica').text(url, { link: url, underline: true });
    this.doc.fillColor(INK);
    this.doc.moveDown(0.15);
  }

  labelOnly(label: string): void {
    this.doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(`${label}:`);
    this.doc.moveDown(0.1);
  }

  /** Bullet with optional trailing "(meta)" and "Sources: url, url". */
  bullet(text: string, opts: { meta?: string; sources?: string[]; link?: string } = {}): void {
    if (this.doc.y > this.doc.page.height - 70) this.doc.addPage();
    const left = this.doc.page.margins.left + 12;
    const width = this.doc.page.width - this.doc.page.margins.right - left;
    const startY = this.doc.y;
    this.doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('•', this.doc.page.margins.left, startY);
    this.doc.fillColor(INK).fontSize(10);
    if (opts.link) {
      this.doc.fillColor(LINK).text(text, left, startY, { link: opts.link, underline: true, width, continued: Boolean(opts.meta || opts.sources?.length) });
      this.doc.fillColor(INK);
    } else {
      this.doc.text(text, left, startY, { width, continued: Boolean(opts.meta || opts.sources?.length) });
    }
    if (opts.meta) {
      this.doc.fillColor(MUTED).fontSize(8).text(`  ${opts.meta}`, { continued: Boolean(opts.sources?.length) });
      this.doc.fillColor(INK).fontSize(10);
    }
    this.appendSources(opts.sources ?? [], left, width);
    this.doc.moveDown(0.2);
  }

  private appendSources(urls: string[], left: number, width: number): void {
    const real = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))].slice(0, 3);
    if (real.length === 0) {
      // close any open `continued` run
      this.doc.text('');
      return;
    }
    this.doc.fillColor(MUTED).fontSize(8).text('   Sources: ', { continued: true });
    real.forEach((url, i) => {
      if (i > 0) this.doc.fillColor(MUTED).text(', ', { continued: true });
      this.doc.fillColor(LINK).text(url, { link: url, underline: true, continued: i < real.length - 1 });
    });
    this.doc.fillColor(INK).fontSize(10);
  }

  stringList(title: string, values: string[]): void {
    this.heading(title);
    if (values.length === 0) {
      this.paragraph(NOT_AVAILABLE);
      return;
    }
    for (const v of values) this.bullet(v);
  }

  async finish(): Promise<Buffer> {
    this.doc.end();
    return this.done;
  }
}

function evidenceFor(evidence: MergedEvidence[], field: string, value: string): MergedEvidence | undefined {
  const normalized = value.trim().toLowerCase();
  return evidence.find((item) => item.field === field && item.value.trim().toLowerCase() === normalized);
}

function metaFor(item?: MergedEvidence): string | undefined {
  return item ? `(${item.verified}; confidence ${item.confidence.toFixed(2)})` : undefined;
}

function urlsFor(item: MergedEvidence | undefined, fallback?: string): string[] {
  if (item?.sourceUrls?.length) return item.sourceUrls;
  return fallback ? [fallback] : [];
}

function buildReportPdf(report: EvidenceAwareReport, evidence: MergedEvidence[] = [], debug?: ResearchDebug): ReportPdf {
  const pdf = new ReportPdf();

  pdf.title(report.company_name || 'Company Research Report');
  pdf.subtitle(
    `Auto-generated company research report — ${new Date().toISOString().slice(0, 10)}. Verify low-confidence fields before use.`,
  );

  if (report.description && report.description.trim() && report.description !== NOT_AVAILABLE) {
    pdf.paragraph(report.description);
  }

  pdf.heading('Executive Summary');
  pdf.paragraph(report.overview?.trim() || report.description?.trim() || NOT_AVAILABLE);

  pdf.heading('Company Profile');
  pdf.labelValue('Industry', report.industry);
  pdf.labelValue('Founded', report.founded);
  pdf.labelValue('Employees', report.employee_count);
  pdf.labelValue('Business model', report.business_model);
  pdf.labelValue('Target customers', report.target_customers);

  pdf.heading('Legal Identity');
  pdf.labelValue('Legal name', report.legal_name);
  pdf.labelValue('Tax / registration ID', report.tax_id || report.registration_id);
  pdf.labelValue('Legal Entity Identifier (LEI)', report.legal_entity_id);
  pdf.labelValue('Jurisdiction', report.jurisdiction);
  pdf.labelValue('Parent company', report.parent_company);

  pdf.heading('Website & Domains');
  if (report.website && /^https?:\/\//.test(report.website)) pdf.labelLink('Website', report.website);
  else pdf.labelValue('Website', NOT_AVAILABLE);
  pdf.labelValue('Domain registered', report.domain_registered);
  pdf.labelValue('Registrar', report.registrar);

  pdf.heading('Contact Details');
  if (report.addresses.length > 0) {
    pdf.labelOnly('Addresses');
    for (const address of report.addresses) {
      const item = evidenceFor(evidence, 'address', address.value);
      pdf.bullet(address.value, { meta: metaFor(item), sources: urlsFor(item, address.source_url) });
    }
  } else pdf.labelValue('Addresses', NOT_AVAILABLE);

  if (report.phones.length > 0) {
    pdf.labelOnly('Phones');
    for (const phone of report.phones) {
      const item = evidenceFor(evidence, 'phone', phone.value);
      pdf.bullet(phone.value, { meta: metaFor(item), sources: urlsFor(item, phone.source_url) });
    }
  } else pdf.labelValue('Phones', NOT_AVAILABLE);

  if (report.emails.length > 0) {
    pdf.labelOnly('Emails');
    for (const email of report.emails) {
      const item = evidenceFor(evidence, 'email', email.value);
      const verified = email.verified ? 'source verified' : 'found but unverified';
      const meta = [metaFor(item), `(${verified})`].filter(Boolean).join(' ');
      pdf.bullet(email.value, { meta, sources: urlsFor(item, email.source) });
    }
  } else pdf.labelValue('Emails', NOT_AVAILABLE);

  pdf.heading('Social Profiles');
  const socials: Array<[string, string]> = [
    ['LinkedIn', report.linkedin_url],
    ['Facebook', report.social_links.facebook],
    ['Instagram', report.social_links.instagram],
    ['Twitter / X', report.social_links.twitter],
    ['YouTube', report.social_links.youtube],
    ['TikTok', report.social_links.tiktok],
    ['WhatsApp', report.social_links.whatsapp],
  ];
  for (const [label, url] of socials) {
    if (url && /^https?:\/\//.test(url)) pdf.labelLink(label, url);
    else pdf.labelValue(label, NOT_AVAILABLE);
  }

  pdf.stringList('Products & Services', report.products_services ?? []);
  pdf.stringList('Markets Served', report.markets_served ?? []);
  pdf.stringList('Technology Stack', report.tech_stack ?? []);

  pdf.heading('Domain / DNS / Email Infrastructure');
  const infraFields = ['domain_registered', 'registrar', 'dns', 'mx_provider', 'spf', 'dmarc'];
  let infraAny = false;
  for (const field of infraFields) {
    const items = evidence.filter((item) => item.field === field);
    if (items.length === 0) continue;
    infraAny = true;
    pdf.labelOnly(field);
    for (const item of items) pdf.bullet(item.value, { meta: metaFor(item), sources: urlsFor(item) });
  }
  if (!infraAny) pdf.paragraph(NOT_AVAILABLE);

  pdf.heading('Key People');
  if (report.key_people.length > 0) {
    for (const person of report.key_people) {
      const sources = person.linkedin ? [person.linkedin, person.source_url] : [person.source_url];
      pdf.bullet(`${person.name} — ${person.role || 'role unknown'}`, { sources });
    }
  } else pdf.paragraph(NOT_AVAILABLE);

  pdf.heading('History Timeline');
  if ((report.history ?? []).length > 0) {
    for (const item of report.history) pdf.bullet(`${item.year ? `${item.year} — ` : ''}${item.event}`);
  } else pdf.paragraph(NOT_AVAILABLE);

  pdf.stringList('News & Awards', [
    ...(report.recent_news ?? []).map((item) => `${item.date ? `${item.date}: ` : ''}${item.headline} — ${item.url}`),
    ...(report.awards ?? []),
  ]);
  pdf.stringList('Clients & Partners', report.notable_clients_partners ?? []);
  pdf.stringList('Competitors', report.competitors ?? []);
  pdf.stringList('Suppliers', report.suppliers ?? []);
  pdf.stringList('Buyers / Customers', report.buyers ?? []);
  pdf.stringList('Distributors', report.distributors ?? []);

  pdf.heading('Public Documents / PDFs Found');
  const pdfs = evidence.filter((item) => item.field === 'pdf_document');
  if (pdfs.length > 0) {
    for (const item of pdfs) pdf.bullet(item.value, { link: item.value, meta: metaFor(item) });
  } else pdf.paragraph(NOT_AVAILABLE);

  const lowConfidence = report.low_confidence_evidence ?? [];
  if (lowConfidence.length > 0) {
    pdf.heading('Found but Unverified');
    for (const item of lowConfidence.slice(0, 30)) {
      pdf.bullet(`${item.field}: ${item.value}`, {
        meta: `(confidence ${item.confidence.toFixed(2)})`,
        sources: item.sourceUrls,
      });
    }
  }

  if (report.not_found.length > 0) {
    pdf.heading('Not Publicly Available');
    pdf.paragraph(report.not_found.join(', '));
  }

  if (debug) {
    pdf.heading('Debug Summary');
    pdf.labelValue('Selected domain', debug.selectedDomain);
    pdf.labelValue('Selected domain confidence', debug.selectedDomainConfidence?.toFixed(2));
    pdf.labelValue('Queries run', String(debug.searchQueriesRun.length));
    pdf.labelValue('Crawled URLs', String(debug.crawledUrls.length));
    pdf.labelValue('Evidence items after dedupe', String(debug.llmInputEvidenceCount));
    if (debug.warnings.length > 0) {
      pdf.labelOnly('Warnings');
      for (const warning of debug.warnings) pdf.bullet(warning);
    }
  }

  return pdf;
}

/**
 * Renders the report to .pdf and uploads it to Supabase Storage as
 * reports/<jobId>.pdf. Returns the public URL.
 */
export async function generateAndUploadPdf(
  jobId: string,
  report: EvidenceAwareReport,
  evidence: MergedEvidence[] = [],
  debug?: ResearchDebug,
): Promise<string> {
  const buffer = await buildReportPdf(report, evidence, debug).finish();
  const path = `${jobId}.pdf`;

  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(path, buffer, { contentType: PDF_MIME, upsert: true });
  if (error) throw new Error(`PDF upload failed: ${error.message}`);

  const { data } = supabase.storage.from(REPORTS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
