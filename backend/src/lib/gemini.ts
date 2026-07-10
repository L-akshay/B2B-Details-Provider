import { withRetry } from './retry';

export const GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Free-tier reality check: which models serve (and whether Google Search
 * grounding is free) varies BY GOOGLE PROJECT — older projects have 2.x
 * models and free grounding on 2.5-flash; newer projects 404 the 2.x line
 * and gate grounding behind billing entirely. The chain covers both worlds
 * in quality order; the cooldown map benches whatever a given key rejects.
 */
export const GEMINI_MODEL_CHAIN = [
  GEMINI_MODEL,
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash',
] as const;

interface GeminiOptions {
  service: string;
  prompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  /** Retries after the first attempt (passed to withRetry; default 2) */
  retries?: number;
  /** Enable the Google Search grounding tool (cannot be combined with responseSchema) */
  useSearchGrounding?: boolean;
  /** Strict structured output; Gemini rejects tools + responseSchema together */
  responseSchema?: unknown;
}

export interface GeminiResult {
  text: string;
  groundingUrls: string[];
}

/**
 * Gemini's Schema proto rejects JSON Schema keywords it doesn't know, so
 * strip `additionalProperties` (and `$schema`) before sending our shared
 * companyReportJsonSchema as a responseSchema.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties' || key === '$schema') continue;
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}

export async function geminiGenerate(opts: GeminiOptions): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const model = opts.model ?? GEMINI_MODEL;

  return withRetry(
    async (signal) => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          signal,
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
            ...(opts.useSearchGrounding ? { tools: [{ googleSearch: {} }] } : {}),
            generationConfig: {
              temperature: opts.temperature ?? 0.2,
              ...(opts.responseSchema
                ? {
                    responseMimeType: 'application/json',
                    responseSchema: toGeminiSchema(opts.responseSchema),
                  }
                : {}),
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
        }>;
      };

      const candidate = json.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
        .trim();
      if (!text) {
        const finishReason = (candidate as { finishReason?: string } | undefined)?.finishReason;
        throw new Error(
          `Gemini returned an empty completion (finishReason: ${finishReason ?? 'none'}, model: ${model})`,
        );
      }

      const groundingUrls = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .map((chunk) => chunk.web?.uri ?? '')
        .filter(Boolean);

      return { text, groundingUrls };
    },
    { service: opts.service, timeoutMs: opts.timeoutMs ?? 90_000, retries: opts.retries },
  );
}

/**
 * Free-tier quotas are per model (and grounded calls have their own paid
 * gate), so when a model 429s we put it on cooldown instead of burning more
 * quota-counted requests against it on every subsequent call.
 */
const quotaCooldowns = new Map<string, number>();

function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 429|RESOURCE_EXHAUSTED|quota/i.test(message);
}

/** Retired models ("no longer available") 404 forever — bench them for 24h. */
function isRetiredModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 404/.test(message) && /no longer available|not found/i.test(message);
}

function quotaCooldownMs(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/retry in ([\d.]+)\s*s/i);
  const suggested = match?.[1] ? Math.ceil(parseFloat(match[1]) * 1000) + 1_000 : null;
  return Math.max(suggested ?? 60_000, 30_000);
}

/**
 * Tries each model in GEMINI_MODEL_CHAIN until one succeeds, so quota
 * differences between models/tiers degrade gracefully instead of failing
 * the whole pass. Non-final models get no same-model retries (any failure
 * falls straight down the chain); the final model retries with backoff.
 */
export async function geminiGenerateWithFallback(
  opts: Omit<GeminiOptions, 'model' | 'retries'>,
): Promise<GeminiResult> {
  const grounded = Boolean(opts.useSearchGrounding);
  let lastError: unknown;
  let attempted = 0;

  for (let i = 0; i < GEMINI_MODEL_CHAIN.length; i++) {
    const model = GEMINI_MODEL_CHAIN[i]!;
    const isLast = i === GEMINI_MODEL_CHAIN.length - 1;
    const cooldownKey = `${model}|${grounded ? 'grounded' : 'plain'}`;
    const coolUntil = quotaCooldowns.get(cooldownKey);
    if (coolUntil && Date.now() < coolUntil && !(isLast && attempted === 0)) continue;

    attempted++;
    try {
      return await geminiGenerate({ ...opts, model, retries: isLast ? 2 : 0 });
    } catch (err) {
      lastError = err;
      if (isRetiredModelError(err)) {
        quotaCooldowns.set(cooldownKey, Date.now() + 24 * 3600 * 1000);
      } else if (isQuotaError(err)) {
        quotaCooldowns.set(cooldownKey, Date.now() + quotaCooldownMs(err));
      }
    }
  }

  throw lastError ?? new Error('all Gemini models are cooling down after quota errors');
}
