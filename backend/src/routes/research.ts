import { Router } from 'express';
import { logger } from '../lib/logger';
import { getSupabase } from '../lib/supabaseClient';
import { researchRateLimiter } from '../middleware/rateLimiter';
import { validateResearchRequest, type ResearchRequestBody } from '../middleware/validateRequest';
import { runResearchJob } from '../services/pipeline';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const researchRouter = Router();

researchRouter.post('/', researchRateLimiter, validateResearchRequest, async (req, res, next) => {
  try {
    const { company_name, extra_info } = req.body as ResearchRequestBody;

    const { data, error } = await getSupabase()
      .from('research_jobs')
      .insert({ company_name, extra_info: extra_info ?? null })
      .select('id')
      .single();
    if (error || !data) {
      throw new Error(`failed to create research job: ${error?.message ?? 'no row returned'}`);
    }

    res.status(202).json({ job_id: data.id });

    // Fire-and-forget after the response; the job row tracks all progress
    setImmediate(() => {
      runResearchJob(data.id, company_name, extra_info).catch((err) =>
        logger.error({ jobId: data.id, err }, 'unhandled pipeline error'),
      );
    });
  } catch (err) {
    next(err);
  }
});

researchRouter.get('/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    if (!jobId || !UUID_RE.test(jobId)) {
      res.status(400).json({ error: 'jobId must be a UUID' });
      return;
    }

    const { data, error } = await getSupabase()
      .from('research_jobs')
      .select('status, stage, result_json, docx_url, error')
      .eq('id', jobId)
      .maybeSingle();
    if (error) throw new Error(`failed to fetch job: ${error.message}`);
    if (!data) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    res.json({
      status: data.status,
      stage: data.stage,
      result_json: data.result_json,
      docx_url: data.docx_url,
      error: data.error,
    });
  } catch (err) {
    next(err);
  }
});
