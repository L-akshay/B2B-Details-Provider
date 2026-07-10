import type { ServiceResult } from '../types/schema';
import { logger } from './logger';

export function ok<T>(data: T, sourceUrl: string): ServiceResult<T> {
  return { data, sourceUrl, success: true, error: null };
}

export function fail<T>(service: string, sourceUrl: string, err: unknown): ServiceResult<T> {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ service, err: message }, 'data collection service failed');
  return { data: null, sourceUrl, success: false, error: `${service}: ${message}` };
}

/** "https://www.Example.com/about" → "example.com" */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === 'unknown' || trimmed === 'not found') return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}
