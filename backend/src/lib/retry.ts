import { logger } from './logger';

export class ExternalApiError extends Error {
  constructor(
    public readonly service: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${service}] ${message}`);
    this.name = 'ExternalApiError';
  }
}

export interface RetryOptions {
  /** Service name used in logs and the thrown ExternalApiError */
  service: string;
  /** Per-attempt timeout in ms (default 30s) */
  timeoutMs?: number;
  /** Retries after the first attempt (default 2 → 3 attempts total) */
  retries?: number;
  /** Backoff base in ms; delays are base * 2^attempt (default 1s → 1s, 2s) */
  baseDelayMs?: number;
}

const MAX_SUGGESTED_DELAY_MS = 45_000;

/**
 * Rate-limit responses often state exactly how long to wait ("Please try
 * again in 26.638s"); honoring that beats blind exponential backoff.
 */
function suggestedDelayMs(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  // Groq says "try again in 26.6s", Gemini says "retry in 26.8s"
  const match = message.match(/(?:try again|retry) in ([\d.]+)\s*s/i);
  if (!match?.[1]) return null;
  const ms = Math.ceil(parseFloat(match[1]) * 1000) + 500;
  return Number.isFinite(ms) ? Math.min(ms, MAX_SUGGESTED_DELAY_MS) : null;
}

/**
 * Runs an external API call with a per-attempt timeout and exponential
 * backoff. The AbortSignal must be passed to the underlying fetch/SDK call
 * so the timeout actually cancels the request.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { service, timeoutMs = 30_000, retries = 2, baseDelayMs = 1_000 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${service} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastError = err;
      logger.warn(
        { service, attempt, err: err instanceof Error ? err.message : String(err) },
        'external API call failed',
      );
      if (attempt < retries) {
        const delay = suggestedDelayMs(err) ?? baseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ExternalApiError(
    service,
    lastError instanceof Error ? lastError.message : String(lastError),
    lastError,
  );
}
