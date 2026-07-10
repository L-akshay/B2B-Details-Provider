import { getSupabase } from './supabaseClient';
import { logger } from './logger';
import type { CompanyReport, JobStatus } from '../types/schema';

export type PipelineStage =
  | 'searching'
  | 'scraping'
  | 'harvesting_contacts'
  | 'extracting'
  | 'reconciling'
  | 'generating_report';

interface JobUpdate {
  status?: JobStatus;
  stage?: PipelineStage | null;
  result_json?: CompanyReport | Record<string, unknown>;
  docx_url?: string;
  error?: string;
}

export async function updateJob(jobId: string, update: JobUpdate): Promise<void> {
  const { error } = await getSupabase().from('research_jobs').update(update).eq('id', jobId);
  if (error) {
    logger.error({ jobId, update: { ...update, result_json: undefined }, error }, 'failed to update job row');
    throw new Error(`Supabase job update failed: ${error.message}`);
  }
}
