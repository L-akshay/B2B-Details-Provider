const BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type Confidence = 'high' | 'unverified';

export interface SourcedValue {
  value: string;
  source_url: string;
  confidence: Confidence;
}

export interface CompanyReport {
  company_name: string;
  description: string;
  legal_name: string;
  tax_id: string;
  addresses: SourcedValue[];
  phones: Array<{ value: string; source_url: string }>;
  emails: Array<{ value: string; verified: boolean; source: string }>;
  website: string;
  linkedin_url: string;
  social_links: {
    facebook: string;
    instagram: string;
    twitter: string;
    youtube: string;
    tiktok: string;
    whatsapp: string;
  };
  industry: string;
  products_services: string[];
  founded: string;
  employee_count: string;
  key_people: Array<{ name: string; role: string; source_url: string; linkedin?: string }>;
  certifications: string[];
  tech_stack: string[];
  domain_registered: string;
  registrar: string;
  recent_news: Array<{ headline: string; url: string; date: string }>;
  overview: string;
  history: Array<{ year: string; event: string }>;
  business_model: string;
  target_customers: string;
  markets_served: string[];
  notable_clients_partners: string[];
  competitors: string[];
  suppliers?: string[];
  buyers?: string[];
  distributors?: string[];
  registration_id?: string;
  legal_entity_id?: string;
  jurisdiction?: string;
  parent_company?: string;
  funding_and_financials: string;
  awards: string[];
  office_locations: string[];
  not_found: string[];
  debug_json?: unknown;
}

export interface JobResponse {
  status: JobStatus;
  stage: string | null;
  result_json: CompanyReport | null;
  docx_url: string | null;
  error: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, password: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-access-password': password,
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the backend — is it running?');
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? `Request failed (HTTP ${response.status})`);
  }
  return body;
}

export function startResearch(
  companyName: string,
  extraInfo: string,
  password: string,
): Promise<{ job_id: string }> {
  return request('/api/research', password, {
    method: 'POST',
    body: JSON.stringify({
      company_name: companyName,
      ...(extraInfo.trim() ? { extra_info: extraInfo.trim() } : {}),
    }),
  });
}

export function getJob(jobId: string, password: string): Promise<JobResponse> {
  return request(`/api/research/${jobId}`, password);
}
