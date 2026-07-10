'use client';

import { useCallback, useEffect, useState } from 'react';
import ChatInput from '@/components/ChatInput';
import ReportView from '@/components/ReportView';
import ResearchProgress from '@/components/ResearchProgress';
import { ApiError, getJob, startResearch, type JobResponse } from '@/lib/api';

const PASSWORD_STORAGE_KEY = 'company-research-access-password';

export default function Home() {
  const [password, setPassword] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordLoaded, setPasswordLoaded] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<{ name: string; extra: string } | null>(null);

  useEffect(() => {
    setPassword(localStorage.getItem(PASSWORD_STORAGE_KEY));
    setPasswordLoaded(true);
  }, []);

  const handleAuthFailure = useCallback(() => {
    localStorage.removeItem(PASSWORD_STORAGE_KEY);
    setPassword(null);
    setJobId(null);
    setJob(null);
    setError('Access password rejected — enter it again.');
  }, []);

  const submit = useCallback(
    async (companyName: string, extraInfo: string) => {
      if (!password) return;
      setError(null);
      setJob({ status: 'queued', stage: null, result_json: null, docx_url: null, error: null });
      setJobId(null);
      setLastQuery({ name: companyName, extra: extraInfo });
      try {
        const { job_id } = await startResearch(companyName, extraInfo, password);
        setJobId(job_id);
      } catch (err) {
        setJob(null);
        if (err instanceof ApiError && err.status === 401) return handleAuthFailure();
        setError(err instanceof Error ? err.message : 'Failed to start research');
      }
    },
    [password, handleAuthFailure],
  );

  useEffect(() => {
    if (!jobId || !password) return;
    if (job && (job.status === 'done' || job.status === 'failed')) return;

    const timer = setInterval(async () => {
      try {
        const next = await getJob(jobId, password);
        setJob(next);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearInterval(timer);
          handleAuthFailure();
        }
        // transient poll errors: keep polling
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [jobId, password, job, handleAuthFailure]);

  if (!passwordLoaded) return null;

  if (!password) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
        <h1 className="text-2xl font-semibold tracking-tight">Company Research</h1>
        <p className="mt-2 text-sm text-slate-500">
          Enter the access password to use this tool.
        </p>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!passwordInput.trim()) return;
            localStorage.setItem(PASSWORD_STORAGE_KEY, passwordInput.trim());
            setPassword(passwordInput.trim());
            setPasswordInput('');
            setError(null);
          }}
        >
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="Access password"
            className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
          >
            Unlock
          </button>
        </form>
      </main>
    );
  }

  const isWorking = job !== null && (job.status === 'queued' || job.status === 'running');

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Company Research</h1>
        <p className="mt-2 text-slate-500">
          Enter a company name — get a structured, source-attributed research report.
        </p>
      </header>

      <ChatInput disabled={isWorking} onSubmit={submit} />

      <div className="mt-8">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {isWorking && <ResearchProgress stage={job.stage} />}

        {job?.status === 'failed' && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5">
            <p className="text-sm font-medium text-red-800">Research failed</p>
            <p className="mt-1 break-words text-sm text-red-700">{job.error ?? 'Unknown error'}</p>
            {lastQuery && (
              <button
                onClick={() => submit(lastQuery.name, lastQuery.extra)}
                className="mt-3 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                Retry “{lastQuery.name}”
              </button>
            )}
          </div>
        )}

        {job?.status === 'done' && job.result_json && (
          <ReportView report={job.result_json} docxUrl={job.docx_url} />
        )}
      </div>
    </main>
  );
}
