import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface GleifRecord {
  lei: string;
  legalName: string;
  address: string;
  status: string;
}

/**
 * GLEIF LEI records (free, authoritative): registered legal entity names and
 * legal addresses for companies that hold a Legal Entity Identifier.
 * Falls back to the simplified trade name when the pasted legal name
 * (punctuated suffixes, country tails) returns nothing.
 */
export async function gleifLookup(
  companyName: string,
  altName?: string,
): Promise<ServiceResult<GleifRecord[]>> {
  const primary = await gleifQuery(companyName);
  if (primary.success || !altName || altName === companyName) return primary;
  return gleifQuery(altName);
}

async function gleifQuery(companyName: string): Promise<ServiceResult<GleifRecord[]>> {
  const url = `https://api.gleif.org/api/v1/lei-records?filter[fulltext]=${encodeURIComponent(companyName)}&page[size]=3`;
  try {
    const records = await withRetry(
      async (signal) => {
        const response = await fetch(url, {
          signal,
          headers: { Accept: 'application/vnd.api+json' },
        });
        if (!response.ok) throw new Error(`GLEIF HTTP ${response.status}`);
        const json = (await response.json()) as {
          data?: Array<{
            attributes?: {
              lei?: string;
              entity?: {
                legalName?: { name?: string };
                legalAddress?: {
                  addressLines?: string[];
                  city?: string;
                  region?: string;
                  country?: string;
                  postalCode?: string;
                };
                status?: string;
              };
            };
          }>;
        };
        return (json.data ?? []).map((record) => {
          const entity = record.attributes?.entity;
          const address = entity?.legalAddress;
          const addressParts = [
            ...(address?.addressLines ?? []),
            address?.city,
            address?.region,
            address?.postalCode,
            address?.country,
          ].filter(Boolean);
          return {
            lei: record.attributes?.lei ?? '',
            legalName: entity?.legalName?.name ?? '',
            address: addressParts.join(', '),
            status: entity?.status ?? '',
          };
        });
      },
      { service: 'gleif', timeoutMs: 15_000 },
    );

    if (records.length === 0) throw new Error(`no LEI records found for "${companyName}"`);
    return ok(records, url);
  } catch (err) {
    return fail('gleif', url, err);
  }
}
