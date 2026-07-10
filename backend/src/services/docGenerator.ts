import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { getSupabase, REPORTS_BUCKET } from '../lib/supabaseClient';
import type { CompanyReport } from '../types/schema';
import type { MergedEvidence } from './research/evidence-deduper';
import type { ResearchDebug } from './research/types';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const NOT_AVAILABLE = 'Not publicly available';

type EvidenceAwareReport = CompanyReport & {
  evidence_sources?: Record<string, string[]>;
  low_confidence_evidence?: Array<{
    field: string;
    value: string;
    confidence: number;
    sourceUrls: string[];
  }>;
};

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 } });
}

function labelValue(label: string, value: string | null | undefined): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun(value && value.trim() ? value : NOT_AVAILABLE),
    ],
    spacing: { after: 60 },
  });
}

function labelOnly(label: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: `${label}: `, bold: true })],
    spacing: { after: 40 },
  });
}

function bullet(children: Array<TextRun | ExternalHyperlink>): Paragraph {
  return new Paragraph({ children, bullet: { level: 0 }, spacing: { after: 40 } });
}

function link(url: string, label?: string): ExternalHyperlink {
  return new ExternalHyperlink({
    children: [new TextRun({ text: label ?? url, style: 'Hyperlink' })],
    link: url,
  });
}

function sourceRuns(urls: string[]): Array<TextRun | ExternalHyperlink> {
  const realUrls = [...new Set(urls.filter((url) => /^https?:\/\//.test(url)))];
  if (realUrls.length === 0) return [];
  const runs: Array<TextRun | ExternalHyperlink> = [new TextRun('  Sources: ')];
  realUrls.slice(0, 3).forEach((url, index) => {
    if (index > 0) runs.push(new TextRun(', '));
    runs.push(link(url, url));
  });
  return runs;
}

function evidenceFor(evidence: MergedEvidence[], field: string, value: string): MergedEvidence | undefined {
  const normalized = value.trim().toLowerCase();
  return evidence.find((item) => item.field === field && item.value.trim().toLowerCase() === normalized);
}

function evidenceMeta(item?: MergedEvidence): TextRun[] {
  if (!item) return [];
  return [new TextRun(`  (${item.verified}; confidence ${item.confidence.toFixed(2)})`)];
}

function evidenceUrls(item: MergedEvidence | undefined, fallback?: string): string[] {
  if (item?.sourceUrls?.length) return item.sourceUrls;
  return fallback ? [fallback] : [];
}

function addStringList(children: Paragraph[], title: string, values: string[]): void {
  children.push(heading(title));
  if (values.length === 0) {
    children.push(new Paragraph(NOT_AVAILABLE));
    return;
  }
  for (const value of values) children.push(bullet([new TextRun(value)]));
}

function buildDocument(
  report: EvidenceAwareReport,
  evidence: MergedEvidence[] = [],
  debug?: ResearchDebug,
): Document {
  const children: Paragraph[] = [
    new Paragraph({ text: report.company_name || 'Company Research Report', heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Auto-generated company research report - ${new Date().toISOString().slice(0, 10)}. Verify low-confidence fields before use.`,
          italics: true,
          size: 18,
        }),
      ],
      spacing: { after: 200 },
    }),
  ];

  if (report.description && report.description.trim() && report.description !== NOT_AVAILABLE) {
    children.push(new Paragraph({ text: report.description, spacing: { after: 160 } }));
  }

  children.push(heading('Executive Summary'));
  children.push(new Paragraph(report.overview?.trim() || report.description?.trim() || NOT_AVAILABLE));

  children.push(
    heading('Company Profile'),
    labelValue('Industry', report.industry),
    labelValue('Founded', report.founded),
    labelValue('Employees', report.employee_count),
    labelValue('Business model', report.business_model),
    labelValue('Target customers', report.target_customers),
  );

  children.push(
    heading('Legal Identity'),
    labelValue('Legal name', report.legal_name),
    labelValue('Tax / registration ID', report.tax_id || report.registration_id),
    labelValue('Legal Entity Identifier (LEI)', report.legal_entity_id),
    labelValue('Jurisdiction', report.jurisdiction),
    labelValue('Parent company', report.parent_company),
  );

  children.push(heading('Website & Domains'));
  if (report.website && /^https?:\/\//.test(report.website)) {
    children.push(new Paragraph({ children: [new TextRun({ text: 'Website: ', bold: true }), link(report.website)] }));
  } else {
    children.push(labelValue('Website', NOT_AVAILABLE));
  }
  children.push(labelValue('Domain registered', report.domain_registered));
  children.push(labelValue('Registrar', report.registrar));

  children.push(heading('Contact Details'));
  if (report.addresses.length > 0) {
    children.push(labelOnly('Addresses'));
    for (const address of report.addresses) {
      const item = evidenceFor(evidence, 'address', address.value);
      children.push(
        bullet([
          new TextRun(address.value),
          ...evidenceMeta(item),
          ...sourceRuns(evidenceUrls(item, address.source_url)),
        ]),
      );
    }
  } else {
    children.push(labelValue('Addresses', NOT_AVAILABLE));
  }

  if (report.phones.length > 0) {
    children.push(labelOnly('Phones'));
    for (const phone of report.phones) {
      const item = evidenceFor(evidence, 'phone', phone.value);
      children.push(
        bullet([
          new TextRun(phone.value),
          ...evidenceMeta(item),
          ...sourceRuns(evidenceUrls(item, phone.source_url)),
        ]),
      );
    }
  } else {
    children.push(labelValue('Phones', NOT_AVAILABLE));
  }

  if (report.emails.length > 0) {
    children.push(labelOnly('Emails'));
    for (const email of report.emails) {
      const item = evidenceFor(evidence, 'email', email.value);
      children.push(
        bullet([
          new TextRun(email.value),
          ...evidenceMeta(item),
          new TextRun(email.verified ? '  (source verified)' : '  (found but unverified)'),
          ...sourceRuns(evidenceUrls(item, email.source)),
        ]),
      );
    }
  } else {
    children.push(labelValue('Emails', NOT_AVAILABLE));
  }

  children.push(heading('Social Profiles'));
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
    children.push(
      url && /^https?:\/\//.test(url)
        ? new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), link(url)] })
        : labelValue(label, NOT_AVAILABLE),
    );
  }

  addStringList(children, 'Products & Services', report.products_services ?? []);
  addStringList(children, 'Markets Served', report.markets_served ?? []);
  addStringList(children, 'Technology Stack', report.tech_stack ?? []);

  children.push(heading('Domain/DNS/Email Infrastructure'));
  const infraFields = ['domain_registered', 'registrar', 'dns', 'mx_provider', 'spf', 'dmarc'];
  for (const field of infraFields) {
    const items = evidence.filter((item) => item.field === field);
    if (items.length === 0) continue;
    children.push(labelOnly(field));
    for (const item of items) {
      children.push(
        bullet([new TextRun(item.value), ...evidenceMeta(item), ...sourceRuns(evidenceUrls(item))]),
      );
    }
  }
  if (!infraFields.some((field) => evidence.some((item) => item.field === field))) {
    children.push(new Paragraph(NOT_AVAILABLE));
  }

  children.push(heading('People'));
  if (report.key_people.length > 0) {
    for (const person of report.key_people) {
      children.push(
        bullet([
          new TextRun({ text: person.name, bold: true }),
          new TextRun(` - ${person.role || 'role unknown'}`),
          ...(person.linkedin ? [new TextRun('  '), link(person.linkedin, 'LinkedIn')] : []),
          ...sourceRuns([person.source_url]),
        ]),
      );
    }
  } else {
    children.push(new Paragraph(NOT_AVAILABLE));
  }

  children.push(heading('History Timeline'));
  if ((report.history ?? []).length > 0) {
    for (const item of report.history) {
      children.push(
        bullet([
          new TextRun({ text: item.year ? `${item.year} - ` : '', bold: true }),
          new TextRun(item.event),
        ]),
      );
    }
  } else {
    children.push(new Paragraph(NOT_AVAILABLE));
  }

  addStringList(children, 'News & Awards', [
    ...(report.recent_news ?? []).map((item) => `${item.date ? `${item.date}: ` : ''}${item.headline} - ${item.url}`),
    ...(report.awards ?? []),
  ]);
  addStringList(children, 'Clients & Partners', report.notable_clients_partners ?? []);
  addStringList(children, 'Competitors', report.competitors ?? []);
  addStringList(children, 'Suppliers', report.suppliers ?? []);
  addStringList(children, 'Buyers / Customers', report.buyers ?? []);
  addStringList(children, 'Distributors', report.distributors ?? []);

  children.push(heading('Documents/PDFs Found'));
  const pdfs = evidence.filter((item) => item.field === 'pdf_document');
  if (pdfs.length > 0) {
    for (const item of pdfs) children.push(bullet([link(item.value, item.value), ...evidenceMeta(item)]));
  } else {
    children.push(new Paragraph(NOT_AVAILABLE));
  }

  const lowConfidence = report.low_confidence_evidence ?? [];
  if (lowConfidence.length > 0) {
    children.push(heading('Found but Unverified'));
    for (const item of lowConfidence.slice(0, 30)) {
      children.push(
        bullet([
          new TextRun({ text: `${item.field}: `, bold: true }),
          new TextRun(item.value),
          new TextRun(`  (confidence ${item.confidence.toFixed(2)})`),
          ...sourceRuns(item.sourceUrls),
        ]),
      );
    }
  }

  if (report.not_found.length > 0) {
    children.push(heading('Not Publicly Available'));
    children.push(new Paragraph(report.not_found.join(', ')));
  }

  if (debug) {
    children.push(heading('Debug Summary'));
    children.push(labelValue('Selected domain', debug.selectedDomain));
    children.push(labelValue('Selected domain confidence', debug.selectedDomainConfidence?.toFixed(2)));
    children.push(labelValue('Queries run', String(debug.searchQueriesRun.length)));
    children.push(labelValue('Crawled URLs', String(debug.crawledUrls.length)));
    children.push(labelValue('Evidence items after dedupe', String(debug.llmInputEvidenceCount)));
    if (debug.warnings.length > 0) {
      children.push(labelOnly('Warnings'));
      for (const warning of debug.warnings) children.push(bullet([new TextRun(warning)]));
    }
  }

  return new Document({ sections: [{ properties: {}, children }] });
}

/**
 * Renders the report to .docx and uploads it to Supabase Storage as
 * reports/<jobId>.docx. The retention cleanup function relies on this exact
 * path convention.
 */
export async function generateAndUploadDocx(
  jobId: string,
  report: EvidenceAwareReport,
  evidence: MergedEvidence[] = [],
  debug?: ResearchDebug,
): Promise<string> {
  const buffer = await Packer.toBuffer(buildDocument(report, evidence, debug));
  const path = `${jobId}.docx`;

  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(path, buffer, { contentType: DOCX_MIME, upsert: true });
  if (error) throw new Error(`DOCX upload failed: ${error.message}`);

  const { data } = supabase.storage.from(REPORTS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
