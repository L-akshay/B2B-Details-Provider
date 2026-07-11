import { simplifyCompanyName } from '../lib/companyName';
import { updateJob } from '../lib/jobs';
import { logger } from '../lib/logger';
import { normalizeDomain } from '../lib/serviceResult';
import type { CompanyReport } from '../types/schema';
import { generateAndUploadPdf } from './docGenerator';
import { buildDebugReport } from './research/debug-builder';
import { findCompetitors } from './research/competitor-finder';
import { findBusinessRelations } from './research/business-relations-finder';
import { queryWikidata } from './research/wikidata-adapter';
import { queryGleif } from './research/gleif-adapter';
import { getResearchConfig } from './research/research-config';
import { extractEntitySeeds, seedsSummary } from './research/entity-seed-extractor';
import { scoreCoverage } from './research/data-coverage-scorer';
import { routeSources } from './research/source-router';
import { generateFollowUpQueries } from './research/follow-up-query-generator';
import { runFollowUpSearch } from './research/search-providers';
import { discoverPublicFiles } from './research/public-file-discovery';
import { queryWayback } from './research/wayback-adapter';
import { querySecEdgar } from './research/sec-edgar-adapter';
import { queryOpenAlex } from './research/openalex-adapter';
import { harvestContacts } from './research/contact-harvester';
import { resolveOfficialDomain } from './research/domain-resolver';
import { dedupeEvidence } from './research/evidence-deduper';
import { normalizeEvidence } from './research/evidence-normalizer';
import { scoreEvidence } from './research/evidence-scorer';
import { assembleDeterministicReport, assembleFinalReport } from './research/final-assembler';
import { reconcileWithLLM } from './research/llm-reconciler';
import { buildHistoryTimeline } from './research/history-news-builder';
import { extractMetadataAndSchema } from './research/metadata-schema-extractor';
import { findPeople } from './research/people-finder';
import { minePublicPdfs } from './research/pdf-miner';
import { getRdapDnsEvidence } from './research/rdap-dns';
import { generateSearchQueries, type GeneratedQuery } from './research/search-query-generator';
import { runSearchProviders } from './research/search-providers';
import { mineSerpResults } from './research/serp-miner';
import { discoverSocialProfiles, handleExpansionQueries } from './research/social-discovery';
import { fingerprintTechStack } from './research/tech-fingerprint';
import { makeEvidence } from './research/types';
import type { CrawledPage, EvidenceItem, ResearchDebug, SerpResult } from './research/types';
import { crawlWebsite } from './research/website-crawler';

type ReportWithDebug = CompanyReport & {
  debug_json?: ResearchDebug;
  evidence_sources?: Record<string, string[]>;
  low_confidence_evidence?: Array<{
    field: string;
    value: string;
    confidence: number;
    sourceUrls: string[];
  }>;
};

function domainFromText(text?: string): string | null {
  if (!text) return null;
  const direct = text.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i)?.[1];
  if (direct) return normalizeDomain(direct);
  const bare = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i)?.[1];
  return bare ? normalizeDomain(bare) : null;
}

function serviceStatus(
  errors: string[] | Record<string, string>,
  skipped = false,
): 'success' | 'failed' | 'skipped' {
  if (skipped) return 'skipped';
  return Array.isArray(errors) ? (errors.length > 0 ? 'failed' : 'success') : Object.keys(errors).length > 0 ? 'failed' : 'success';
}

function dedupeSerp(results: SerpResult[]): SerpResult[] {
  const seen = new Set<string>();
  const out: SerpResult[] = [];
  for (const result of results) {
    const key = `${result.query}::${result.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function evidenceSourcesFromReport(report: ReportWithDebug): Record<string, string[]> {
  return report.evidence_sources ?? {};
}

function finalFilledFieldCount(report: CompanyReport): number {
  let count = 0;
  for (const [key, value] of Object.entries(report)) {
    if (key === 'not_found') continue;
    if (Array.isArray(value) && value.length > 0) count++;
    else if (value && typeof value === 'object' && Object.values(value).some((v) => typeof v === 'string' && v.trim())) count++;
    else if (typeof value === 'string' && value.trim()) count++;
  }
  return count;
}

async function runHandleExpansion(handles: string[]): Promise<{ results: SerpResult[]; queriesRun: string[]; errors: string[] }> {
  if (handles.length === 0) return { results: [], queriesRun: [], errors: [] };
  const queries: GeneratedQuery[] = handleExpansionQueries(handles).map((query) => ({
    intent: 'social',
    query,
    priority: 50,
  }));
  const output = await runSearchProviders(queries.slice(0, 12));
  return { results: output.results, queriesRun: output.queriesRun, errors: output.errors };
}

export async function runResearchJob(
  jobId: string,
  companyName: string,
  extraInfo?: string,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const log = logger.child({ jobId, companyName });
  const serviceErrors: Record<string, string> = {};
  const warnings: string[] = [];

  try {
    const searchName = simplifyCompanyName(companyName);
    if (searchName !== companyName) log.info({ searchName }, 'using simplified search name');

    await updateJob(jobId, { status: 'running', stage: 'searching' });
    const initialDomain = domainFromText(extraInfo);
    const queries = generateSearchQueries({
      companyName: searchName,
      domain: initialDomain ?? undefined,
    });
    console.log('[research] queries generated', queries.length);
    const searchOutput = await runSearchProviders(queries, searchName);
    console.log('[research] search results', searchOutput.results.length);
    if (searchOutput.results.length === 0) {
      throw new Error('Research failed: no search provider returned public results. Check search provider configuration.');
    }
    if (searchOutput.errors.length > 0) {
      serviceErrors.search = searchOutput.errors.join('\n').slice(0, 2000);
      warnings.push('Some search queries failed; continuing with available results.');
    }

    let serpResults = searchOutput.results;
    let serpEvidence = mineSerpResults(serpResults);
    console.log('[research] serp evidence', serpEvidence.length);

    await updateJob(jobId, { stage: 'scraping' });
    const domainResolution = await resolveOfficialDomain(
      searchName,
      serpEvidence,
      initialDomain ? [{ domain: initialDomain, points: 35, reason: 'domain supplied in extra_info' }] : [],
    );
    // A domain the user explicitly typed is an instruction, not a hint — it
    // wins over any same-brand lookalike the resolver might score higher
    // (e.g. a US "BioAdvance Capital" vs the intended "Bioadvance Mexico").
    if (initialDomain && domainResolution.selectedDomain !== initialDomain) {
      if (domainResolution.selectedDomain) {
        domainResolution.alternativeDomains = [
          domainResolution.selectedDomain,
          ...domainResolution.alternativeDomains.filter((d) => d !== initialDomain),
        ];
      }
      domainResolution.selectedDomain = initialDomain;
      domainResolution.confidence = 0.9;
      domainResolution.status = 'verified';
      domainResolution.reasoning = ['domain explicitly supplied by requester in extra_info'];
      // Rebuild the official_website evidence for the supplied domain — the
      // resolver's evidence still points at whatever it had picked.
      domainResolution.evidence = [
        makeEvidence({
          field: 'official_website',
          value: `https://${initialDomain}`,
          sourceUrl: `https://${initialDomain}`,
          sourceType: 'manual_fallback',
          extractedBy: 'serp',
          confidence: 0.95,
          domain: initialDomain,
          evidenceText: 'domain supplied by requester',
        }),
        ...domainResolution.evidence.filter((e) => e.field !== 'official_website'),
      ];
      warnings.push(`Using requester-supplied domain: ${initialDomain}`);
    }
    if (domainResolution.status !== 'verified' && domainResolution.selectedDomain) {
      warnings.push(`Official domain found but unverified: ${domainResolution.selectedDomain}`);
    }
    console.log('[research] selected domain', domainResolution.selectedDomain, domainResolution.confidence);
    if (!domainResolution.selectedDomain) {
      warnings.push('No official domain resolved; website-dependent extraction was skipped.');
    }

    let pages: CrawledPage[] = [];
    let crawlAttempts: ResearchDebug['crawledUrls'] = [];
    let crawlPdfLinks: string[] = [];
    if (domainResolution.selectedDomain) {
      try {
        const crawl = await crawlWebsite(domainResolution.selectedDomain);
        pages = crawl.pages;
        crawlPdfLinks = crawl.pdfLinks;
        crawlAttempts = crawl.attempts;
        console.log('[research] crawled pages', pages.length);
        console.log('[research] total crawled text length', pages.reduce((sum, page) => sum + page.text.length, 0));
        if (crawl.disallowedPaths.includes('/') && pages.length === 0) {
          warnings.push('robots.txt disallowed crawling the selected domain.');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        serviceErrors.crawler = message;
        warnings.push(`Website crawl failed: ${message}`);
      }
    }

    await updateJob(jobId, { stage: 'harvesting_contacts' });
    const contactEvidence = harvestContacts(pages);
    console.log('[research] contact evidence', contactEvidence.length);
    const socialDiscovery = discoverSocialProfiles(pages, serpEvidence);
    if (socialDiscovery.handles.length > 0) {
      const expanded = await runHandleExpansion(socialDiscovery.handles);
      serpResults = dedupeSerp([...serpResults, ...expanded.results]);
      serpEvidence = mineSerpResults(serpResults);
      console.log('[research] search results', serpResults.length);
      console.log('[research] serp evidence', serpEvidence.length);
      if (expanded.errors.length > 0) {
        serviceErrors.social_search = expanded.errors.join('\n').slice(0, 1500);
      }
    }
    console.log('[research] social evidence', socialDiscovery.evidence.length);
    const metadataEvidence = extractMetadataAndSchema(pages);
    console.log('[research] metadata evidence', metadataEvidence.length);

    await updateJob(jobId, { stage: 'extracting' });
    const techEvidence = fingerprintTechStack(pages);
    console.log('[research] tech evidence', techEvidence.length);
    if (domainResolution.selectedDomain && pages.length > 0 && techEvidence.length === 0) {
      warnings.push('Tech stack fingerprinting ran but found no recognizable signatures.');
    }

    const [pdfEvidence, rdapDns] = await Promise.all([
      minePublicPdfs(crawlPdfLinks, serpResults),
      domainResolution.selectedDomain
        ? getRdapDnsEvidence(domainResolution.selectedDomain)
        : Promise.resolve({ evidence: [] as EvidenceItem[], errors: { rdap_dns: 'skipped: no selected domain' } }),
    ]);
    console.log('[research] pdf evidence', pdfEvidence.length);
    console.log('[research] rdap dns evidence', rdapDns.evidence.length);
    Object.assign(serviceErrors, rdapDns.errors);

    // ── RECURSIVE DISCOVERY (round 1) ────────────────────────────────────
    // Mine expansion seeds from what round 0 found, score coverage, and if
    // coverage is weak run a targeted follow-up search round whose queries
    // pivot on the seeds (legal name, handles, products) + missing fields.
    const config = getResearchConfig();
    const round0Evidence: EvidenceItem[] = [
      ...serpEvidence,
      ...domainResolution.evidence,
      ...contactEvidence,
      ...socialDiscovery.evidence,
      ...metadataEvidence,
      ...techEvidence,
      ...pdfEvidence,
      ...rdapDns.evidence,
    ];
    const seeds = extractEntitySeeds(searchName, round0Evidence, pages);
    const coverage = scoreCoverage(round0Evidence);
    console.log('[research] coverage after round 0', coverage.coverageScore, 'missing:', coverage.missingCriticalFields.join(','));
    const sourcePlan = routeSources({
      companyName: searchName,
      seeds,
      coverage,
      evidence: round0Evidence,
      pages,
      selectedDomain: domainResolution.selectedDomain ?? undefined,
    });

    const discoveryRounds: NonNullable<ResearchDebug['discoveryRounds']> = [
      {
        round: 0,
        queriesRun: searchOutput.queriesRun,
        searchResults: serpResults.length,
        evidenceFound: round0Evidence.length,
        newSeeds: seedsSummary(seeds),
      },
    ];

    if (coverage.coverageScore < config.coverageStopThreshold) {
      const followQueries = generateFollowUpQueries(searchName, seeds, coverage, sourcePlan);
      if (followQueries.length > 0) {
        const followOut = await runFollowUpSearch(followQueries, config.maxFollowUpQueries);
        if (followOut.errors.length > 0) {
          serviceErrors.follow_up_search = followOut.errors.join('\n').slice(0, 1200);
        }
        serpResults = dedupeSerp([...serpResults, ...followOut.results]);
        serpEvidence = mineSerpResults(serpResults);
        console.log('[research] follow-up search results', followOut.results.length);
        console.log('[research] serp evidence after round 1', serpEvidence.length);
        discoveryRounds.push({
          round: 1,
          queriesRun: followOut.queriesRun,
          searchResults: followOut.results.length,
          evidenceFound: serpEvidence.length,
        });
      }
    } else {
      console.log('[research] coverage strong, skipping follow-up round');
    }

    // Routed free sources (public files / Wayback / SEC EDGAR / OpenAlex)
    const [publicFiles, wayback, edgar, openalex] = await Promise.all([
      sourcePlan.sources.includes('public_files') && domainResolution.selectedDomain
        ? discoverPublicFiles(domainResolution.selectedDomain).catch((err) => ({ evidence: [] as EvidenceItem[], errors: { public_files: String(err) } }))
        : Promise.resolve({ evidence: [] as EvidenceItem[], errors: {} as Record<string, string> }),
      sourcePlan.sources.includes('wayback') && domainResolution.selectedDomain
        ? queryWayback(domainResolution.selectedDomain).catch((err) => ({ evidence: [] as EvidenceItem[], errors: { wayback: String(err) } }))
        : Promise.resolve({ evidence: [] as EvidenceItem[], errors: {} as Record<string, string> }),
      sourcePlan.sources.includes('sec_edgar')
        ? querySecEdgar(searchName).catch((err) => ({ evidence: [] as EvidenceItem[], errors: { sec_edgar: String(err) } }))
        : Promise.resolve({ evidence: [] as EvidenceItem[], errors: {} as Record<string, string> }),
      sourcePlan.sources.includes('openalex')
        ? queryOpenAlex(searchName).catch((err) => ({ evidence: [] as EvidenceItem[], errors: { openalex: String(err) } }))
        : Promise.resolve({ evidence: [] as EvidenceItem[], errors: {} as Record<string, string> }),
    ]);
    console.log('[research] public-file evidence', publicFiles.evidence.length);
    console.log('[research] wayback evidence', wayback.evidence.length);
    console.log('[research] sec edgar evidence', edgar.evidence.length);
    console.log('[research] openalex evidence', openalex.evidence.length);
    Object.assign(serviceErrors, publicFiles.errors, wayback.errors, edgar.errors, openalex.errors);

    const peopleEvidence = findPeople(searchName, serpResults, pages);
    console.log('[research] people evidence', peopleEvidence.length);
    const historyEvidence = await buildHistoryTimeline(searchName, pages, serpResults, pdfEvidence);
    console.log('[research] history evidence', historyEvidence.length);
    const competitorEvidence = findCompetitors(searchName, serpResults, pages);
    console.log('[research] competitor evidence', competitorEvidence.length);
    const relationEvidence = findBusinessRelations(
      searchName,
      serpResults,
      pages,
      domainResolution.selectedDomain ?? undefined,
    );
    console.log('[research] business relation evidence', relationEvidence.length);

    // Free public identity databases (no API key) — legal name, LEI, founding,
    // HQ, industry, parent company. Failures degrade gracefully to [].
    const [wikidataEvidence, gleifEvidence] = await Promise.all([
      queryWikidata(searchName).catch((err) => {
        serviceErrors.wikidata = String(err);
        return [] as EvidenceItem[];
      }),
      queryGleif(searchName).catch((err) => {
        serviceErrors.gleif = String(err);
        return [] as EvidenceItem[];
      }),
    ]);
    console.log('[research] wikidata evidence', wikidataEvidence.length);
    console.log('[research] gleif evidence', gleifEvidence.length);

    const rawEvidence: EvidenceItem[] = [
      ...serpEvidence,
      ...domainResolution.evidence,
      ...contactEvidence,
      ...socialDiscovery.evidence,
      ...metadataEvidence,
      ...techEvidence,
      ...pdfEvidence,
      ...rdapDns.evidence,
      ...peopleEvidence,
      ...historyEvidence,
      ...competitorEvidence,
      ...relationEvidence,
      ...wikidataEvidence,
      ...gleifEvidence,
      ...publicFiles.evidence,
      ...wayback.evidence,
      ...edgar.evidence,
      ...openalex.evidence,
    ];
    console.log('[research] total evidence before scoring', rawEvidence.length);

    // Anchor PEOPLE to the real company. Same-named companies (e.g. a US
    // "BioAdvance Capital" vs the intended medical firm) pollute name-based
    // people search, so a key_person is only trusted when it comes from the
    // official domain's own pages OR from a LinkedIn /in profile whose result
    // text actually names this company. Other person evidence is dropped.
    const selDomain = domainResolution.selectedDomain;
    const brandTokens = searchName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    const anchoredEvidence = selDomain
      ? rawEvidence.filter((e) => {
          if (e.field !== 'key_person') return true;
          // Trusted structured databases resolve the entity themselves — keep
          // their people (founder/CEO from Wikidata/GLEIF) regardless of host.
          if (e.sourceType === 'wikidata' || e.sourceType === 'gleif') return true;
          const host = (() => {
            try {
              return new URL(e.sourceUrl).hostname.replace(/^www\./, '');
            } catch {
              return '';
            }
          })();
          if (host.endsWith(selDomain)) return true;
          // Data-broker directories list people of AMBIGUOUS same-named
          // entities — never trust them for person attribution.
          if (/datanyze|zoominfo|apollo\.io|rocketreach|leadiq|signalhire|lusha|contactout|theorg\.com/i.test(host)) {
            return false;
          }
          // Same-name TWIN domain (bioadvance.com when the real company is
          // bioadvancelatam.com): its team pages describe a different company.
          const hostRoot = host.split('.').slice(0, -1).join('.');
          if (brandTokens.some((t) => hostRoot.includes(t)) && !host.endsWith(selDomain)) return false;
          // Otherwise require the snippet/title to actually name the company
          const hay = `${e.sourceTitle ?? ''} ${e.evidenceText ?? ''}`.toLowerCase();
          return brandTokens.some((t) => hay.includes(t));
        })
      : rawEvidence;
    const droppedPeople = rawEvidence.length - anchoredEvidence.length;
    if (droppedPeople > 0) console.log('[research] dropped off-company people', droppedPeople);

    const normalized = normalizeEvidence(anchoredEvidence);
    const scored = scoreEvidence(normalized);
    console.log('[research] evidence after scoring', scored.length);
    const deduped = dedupeEvidence(scored);
    console.log('[research] evidence after dedupe', deduped.length);

    await updateJob(jobId, { stage: 'reconciling' });
    const deterministicDraft = assembleDeterministicReport(companyName, deduped);
    // AI runs LAST and write-only: it composes narrative fields from the
    // script-collected evidence and can never overwrite deterministic facts.
    const llm = await reconcileWithLLM(searchName, deduped, domainResolution.selectedDomain ?? undefined, pages);
    if (llm.error) serviceErrors.llm_reconciliation = llm.error.slice(0, 800);
    console.log('[research] llm reconciliation', llm.output ? 'applied' : 'skipped');
    const finalReport = assembleFinalReport(deterministicDraft, llm.output);
    // Merge AI-extracted people (named on the company's own pages / in news)
    // with the script-found LinkedIn people, deduped by name. These are
    // grounded in the crawled sources, sourced to the official website.
    if (llm.people.length > 0) {
      const existing = new Set(finalReport.key_people.map((p) => p.name.toLowerCase()));
      const websiteSrc = finalReport.website || (domainResolution.selectedDomain ? `https://${domainResolution.selectedDomain}` : '');
      for (const person of llm.people) {
        if (existing.has(person.name.toLowerCase())) continue;
        existing.add(person.name.toLowerCase());
        finalReport.key_people.push({ name: person.name, role: person.role, source_url: websiteSrc });
      }
    }
    // Final people cleanup: drop non-name phrases that leak from SERP snippet
    // parsing ("Corporate Spend", "Wikipedia Ramp Business", "Eric Glyman
    // Explains", "Executive Director") — a real person is 2-3 capitalized name
    // words, none of which is a company/role/topic word or a company brand token.
    const NON_NAME_WORD =
      /\b(Corporate|Spend|Wikipedia|Explains?|Business|Executive|Director|Manager|Officer|President|Founder|Solutions|Platform|Company|Review|News|Overview|Profile|About|Board|Team|Group|Capital|Sciences|Inc|LLC|Ltd|Corp|The|And|For|With|How|Why|What|Best|Top|Employees?|List|Greater|Global|International|Regional|Philadelphia|Medical|Devices?)\b/i;
    finalReport.key_people = finalReport.key_people.filter((p) => {
      const words = p.name.trim().split(/\s+/);
      if (words.length < 2 || words.length > 3) return false;
      if (NON_NAME_WORD.test(p.name)) return false;
      if (brandTokens.some((t) => p.name.toLowerCase().includes(t))) return false;
      return words.every((w) => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]+$/.test(w));
    });
    if (finalReport.key_people.length > 0) {
      finalReport.not_found = finalReport.not_found.filter((f) => f !== 'key_people');
    } else if (!finalReport.not_found.includes('key_people')) {
      finalReport.not_found.push('key_people');
    }
    console.log('[research] key people', finalReport.key_people.length);
    console.log('[research] final filled fields', finalFilledFieldCount(finalReport));

    await updateJob(jobId, { stage: 'generating_report' });
    const debug = buildDebugReport({
      companyInput: companyName,
      startedAt,
      finishedAt: new Date().toISOString(),
      generatedQueriesCount: queries.length,
      serpEvidenceCount: serpEvidence.length,
      selectedDomain: domainResolution.selectedDomain,
      selectedDomainConfidence: domainResolution.confidence,
      candidateDomains: domainResolution.candidates,
      searchQueriesRun: searchOutput.queriesRun,
      serpResults,
      crawledUrls: crawlAttempts,
      servicesCalled: {
        search: serviceStatus(searchOutput.errors),
        domain_resolver: domainResolution.selectedDomain ? 'success' : 'failed',
        crawler: serviceStatus(serviceErrors.crawler ? { crawler: serviceErrors.crawler } : {}, !domainResolution.selectedDomain),
        contacts: 'success',
        socials: 'success',
        metadata_schema: 'success',
        tech_fingerprint: pages.length > 0 ? 'success' : 'skipped',
        pdf_miner: 'success',
        rdap_dns: serviceStatus(rdapDns.errors, !domainResolution.selectedDomain),
        people_finder: 'success',
        history_news: 'success',
        competitor_finder: 'success',
        public_files: sourcePlan.sources.includes('public_files') ? serviceStatus(publicFiles.errors) : 'skipped',
        wayback: sourcePlan.sources.includes('wayback') ? serviceStatus(wayback.errors) : 'skipped',
        sec_edgar: sourcePlan.sources.includes('sec_edgar') ? serviceStatus(edgar.errors) : 'skipped',
        openalex: sourcePlan.sources.includes('openalex') ? serviceStatus(openalex.errors) : 'skipped',
        follow_up_search: discoveryRounds.length > 1 ? 'success' : 'skipped',
        llm_reconciliation: llm.output ? 'success' : 'failed',
      },
      serviceErrors,
      evidence: deduped,
      rawEvidence,
      llmInputEvidenceCount: deduped.length,
      llmOutput: llm.output,
      deterministicOverridesApplied: [
        'official_website',
        'emails',
        'phones',
        'addresses',
        'social_links',
        'domain_registered',
        'registrar',
        'dns',
        'mx_provider',
        'spf',
        'dmarc',
        'tech_stack',
        'pdf_document',
      ],
      finalFieldSources: evidenceSourcesFromReport(finalReport),
      fieldsFilteredDueToConfidence: scored
        .filter((item) => item.confidence < 0.75)
        .map((item) => `${item.field}:${item.value}`.slice(0, 160)),
      fieldsIgnoredDueToSchemaMismatch: [],
      warnings,
      pages,
    });
    // Recursive-discovery telemetry: explains WHY a report has more/less data
    debug.coverageScore = coverage.coverageScore;
    debug.missingCriticalFields = coverage.missingCriticalFields;
    debug.recommendedNextActions = coverage.recommendedNextActions;
    debug.discoveryRounds = discoveryRounds;
    debug.sourceRouter = { sourcesSelected: sourcePlan.selected, sourcesSkipped: sourcePlan.skipped };
    debug.moduleCounts = {
      serpEvidence: serpEvidence.length,
      contactEvidence: contactEvidence.length,
      socialEvidence: socialDiscovery.evidence.length,
      metadataEvidence: metadataEvidence.length,
      techEvidence: techEvidence.length,
      pdfEvidence: pdfEvidence.length,
      rdapDnsEvidence: rdapDns.evidence.length,
      peopleEvidence: peopleEvidence.length,
      historyEvidence: historyEvidence.length,
      competitorEvidence: competitorEvidence.length,
      relationEvidence: relationEvidence.length,
      wikidataEvidence: wikidataEvidence.length,
      gleifEvidence: gleifEvidence.length,
      publicFilesEvidence: publicFiles.evidence.length,
      waybackEvidence: wayback.evidence.length,
      secEdgarEvidence: edgar.evidence.length,
      openalexEvidence: openalex.evidence.length,
    };

    if (deduped.length < 5) {
      await updateJob(jobId, {
        status: 'failed',
        stage: null,
        error: 'Research failed: evidence collection returned too few source-backed facts. Check debug JSON.',
        result_json: { company_name: companyName, debug_json: debug },
      });
      return;
    }

    const reportWithDebug: ReportWithDebug = { ...finalReport, debug_json: debug };
    const docxUrl = await generateAndUploadPdf(jobId, reportWithDebug, deduped, debug);

    await updateJob(jobId, {
      status: 'done',
      stage: null,
      result_json: reportWithDebug,
      docx_url: docxUrl,
    });
    log.info({ evidence: deduped.length }, 'research job complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'research job failed');
    await updateJob(jobId, { status: 'failed', stage: null, error: message }).catch((updateErr) =>
      log.error({ err: updateErr }, 'failed to mark job as failed'),
    );
  }
}
