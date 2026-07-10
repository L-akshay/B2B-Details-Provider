import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeEvidence } from './evidence-deduper';
import { normalizeEvidence } from './evidence-normalizer';
import { scoreEvidence } from './evidence-scorer';
import { assembleDeterministicReport } from './final-assembler';
import { generateSearchQueries } from './search-query-generator';
import { makeEvidence, type EvidenceItem } from './types';

function prepare(items: EvidenceItem[]) {
  return dedupeEvidence(scoreEvidence(normalizeEvidence(items)));
}

test('query generator includes targeted social, contact, document, and country variants', () => {
  const queries = generateSearchQueries({
    companyName: 'Bioadvance Dispositivos e Innovaciones Medicas S.A. de C.V.',
    country: 'Mexico',
  }).map((item) => item.query);

  assert(queries.length >= 40);
  assert(queries.some((query) => query.includes('site:linkedin.com/company')));
  assert(queries.some((query) => query.includes('Instagram')));
  assert(queries.some((query) => query.includes('filetype:pdf')));
  assert(queries.some((query) => query.includes('Mexico contact')));
});

test('assembler does not mark fields not publicly available when deterministic evidence exists', () => {
  const evidence = prepare([
    makeEvidence({
      field: 'official_website',
      value: 'https://bioadvancelatam.com',
      sourceUrl: 'https://bioadvancelatam.com',
      sourceType: 'official_website',
      extractedBy: 'cheerio',
      confidence: 0.95,
    }),
    makeEvidence({
      field: 'email',
      value: 'contacto@bioadvancelatam.com',
      sourceUrl: 'https://bioadvancelatam.com/contacto',
      sourceType: 'official_website',
      extractedBy: 'regex',
      confidence: 0.95,
    }),
    makeEvidence({
      field: 'phone',
      value: '+52 33 1456 7890',
      sourceUrl: 'https://bioadvancelatam.com/contacto',
      sourceType: 'official_website',
      extractedBy: 'regex',
      confidence: 0.85,
    }),
    makeEvidence({
      field: 'address',
      value: 'Av. Vallarta 1234, Guadalajara, Jalisco, Mexico',
      sourceUrl: 'https://bioadvancelatam.com/aviso-de-privacidad',
      sourceType: 'official_website',
      extractedBy: 'regex',
      confidence: 0.8,
    }),
  ]);

  const report = assembleDeterministicReport('Bioadvance Dispositivos e Innovaciones Medicas S.A. de C.V.', evidence);

  assert.equal(report.website, 'https://bioadvancelatam.com');
  assert.equal(report.emails.length, 1);
  assert.equal(report.phones.length, 1);
  assert.equal(report.addresses.length, 1);
  assert(!report.not_found.includes('emails'));
  assert(!report.not_found.includes('phones'));
  assert(!report.not_found.includes('addresses'));
});

test('debug-only suspicious values stay out of verified and unverified contact blocks', () => {
  const evidence = prepare([
    makeEvidence({
      field: 'phone',
      value: '+52 33 1234 5678',
      sourceUrl: 'https://example.com',
      sourceType: 'search_result',
      extractedBy: 'regex',
      confidence: 0.35,
      verified: 'low_confidence',
    }),
  ]);

  const report = assembleDeterministicReport('Example Company', evidence);

  assert.equal(report.phones.length, 0);
  assert(report.not_found.includes('phones'));
  assert.equal(report.low_confidence_evidence?.length, 0);
});

test('mid-confidence evidence is preserved as found but unverified', () => {
  const evidence = prepare([
    makeEvidence({
      field: 'competitor',
      value: 'Comparable Medical Supplier',
      sourceUrl: 'https://example.com/comparison',
      sourceType: 'third_party_directory',
      extractedBy: 'serp',
      confidence: 0.5,
      verified: 'low_confidence',
    }),
  ]);

  const report = assembleDeterministicReport('Example Company', evidence);

  assert.equal(report.competitors.length, 0);
  assert.equal(report.low_confidence_evidence?.length, 1);
  assert.equal(report.low_confidence_evidence?.[0]?.field, 'competitor');
});
