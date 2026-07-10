# Company Research / Lead Enrichment Tool

Give it a company name, get back a structured, source-attributed research report (legal info, contacts, key people, tech stack, recent news) plus a downloadable `.docx`.

## Architecture

```
frontend/   Next.js 14 (App Router) + Tailwind — deployed on Vercel
backend/    Node.js + Express (TypeScript)     — deployed on Render
```

- **Database + storage**: Supabase — `research_jobs` table for job state/results, `reports` storage bucket for generated `.docx` files. Rows + report files auto-delete after 90 days (PII retention, enforced by the `cleanup-old-jobs` edge function + pg_cron).
- **AI pipeline**: Groq `groq/compound` (web-search grounding) → parallel extraction with Groq `openai/gpt-oss-120b` (pass A, json_object mode) and Gemini with Google Search grounding (pass B; model chain `gemini-3.5-flash` → `gemini-2.5-flash`, because grounding on 3.5 needs a paid tier) → Gemini reconciliation with strict JSON schema and per-field confidence.
- **Free enrichment sources**: Firecrawl (home/about/contact/team scrape), Wikidata (founded/HQ/industry/executives/socials), GLEIF LEI registry (legal names + legal addresses), Google News RSS (dated headlines with real URLs), RDAP (domain age/registrar), DNS MX/TXT/NS (email provider + SaaS hints), signature-based tech-stack fingerprinting, deterministic email/phone harvesting with live MX verification (emails can never be hallucinated — models may only echo the harvested list). Google Custom Search is optional and skipped when unconfigured.
- **Access**: every `/api` request requires the shared `ACCESS_PASSWORD` (sent as `x-access-password`); the frontend asks once and stores it in the browser.

## API

```
POST /api/research          { company_name, extra_info? } → { job_id }
GET  /api/research/:jobId   → { status, result_json?, docx_url?, error? }
GET  /health                → { ok: true }
```

Jobs are processed asynchronously: `queued → running → done | failed`, with a live `stage` field (`searching → scraping → harvesting_contacts → extracting → reconciling → generating_report`). The frontend polls the job endpoint every 2 seconds and renders per-stage progress.

## Local development

```bash
# Backend (http://localhost:4000)
cd backend
cp .env.example .env    # fill in real values
npm install
npm run dev

# Frontend (http://localhost:3000)
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

## Deployment

- **Backend → Render**: Blueprint in `render.yaml` (repo root). All secrets are entered in the Render dashboard (`sync: false`), never committed.
- **Frontend → Vercel**: standard Next.js deploy from `frontend/`; set `NEXT_PUBLIC_BACKEND_URL` to the Render URL in Vercel project settings.
- **CORS**: backend only allows the origin(s) in `ALLOWED_ORIGIN`.

## Environment variables

See `backend/.env.example` and `frontend/.env.local.example` for the full annotated list. Never commit `.env` / `.env.local`.
