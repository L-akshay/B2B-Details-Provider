import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Data retention policy: research_jobs rows and their generated .docx reports
// hold scraped PII (emails, phones) and are purged after 90 days.
// Deployed to the company-research Supabase project and invoked daily at
// 03:00 UTC by pg_cron (job: purge-old-research-jobs).
const RETENTION_DAYS = 90;

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: oldJobs, error: selectError } = await supabase
    .from("research_jobs")
    .select("id")
    .lt("created_at", cutoff);

  if (selectError) {
    return new Response(JSON.stringify({ error: selectError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const jobs = oldJobs ?? [];
  if (jobs.length > 0) {
    // Reports are stored as reports/<job_id>.docx (docGenerator enforces this)
    const paths = jobs.map((job) => `${job.id}.docx`);
    const { error: storageError } = await supabase.storage.from("reports").remove(paths);
    if (storageError) {
      // A missing file (e.g. failed job that never produced a docx) is fine;
      // row deletion must still proceed.
      console.error("storage cleanup error:", storageError.message);
    }

    const { error: deleteError } = await supabase
      .from("research_jobs")
      .delete()
      .lt("created_at", cutoff);

    if (deleteError) {
      return new Response(JSON.stringify({ error: deleteError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ purged: jobs.length, cutoff }), {
    headers: { "Content-Type": "application/json" },
  });
});
