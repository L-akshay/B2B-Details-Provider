/**
 * Budget/deep mode knobs for the recursive discovery engine.
 * Default is budget mode; set DEEP_MODE=true (or RESEARCH_MODE=deep) for the
 * heavier profile. Individual env vars still override (CRAWLER_MAX_PAGES etc).
 */
export interface ResearchModeConfig {
  mode: 'budget' | 'deep';
  maxFollowUpQueries: number;
  maxPdfs: number;
  maxCrawledPages: number;
  /** Stop discovery when coverage reaches this (deep mode keeps digging longer) */
  coverageStopThreshold: number;
}

export function getResearchConfig(): ResearchModeConfig {
  const deep = process.env.DEEP_MODE === 'true' || process.env.RESEARCH_MODE === 'deep';
  return deep
    ? {
        mode: 'deep',
        maxFollowUpQueries: 30,
        maxPdfs: Number(process.env.PDF_MAX_COUNT) || 15,
        maxCrawledPages: Number(process.env.CRAWLER_MAX_PAGES) || 150,
        coverageStopThreshold: 85,
      }
    : {
        mode: 'budget',
        maxFollowUpQueries: 14,
        maxPdfs: Number(process.env.PDF_MAX_COUNT) || 5,
        maxCrawledPages: Number(process.env.CRAWLER_MAX_PAGES) || 50,
        coverageStopThreshold: 70,
      };
}
