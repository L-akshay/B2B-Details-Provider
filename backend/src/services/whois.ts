import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface DomainRegistration {
  registered: string | null;
  expires: string | null;
  lastChanged: string | null;
  registrar: string | null;
  domainAgeYears: number | null;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, Array<[string, unknown, string, unknown]>];
}

/**
 * Domain registration facts via RDAP, the structured HTTPS successor to
 * whois — more reliable from cloud hosts than port-43 whois and needs no key.
 */
export async function domainRegistration(
  domain: string,
): Promise<ServiceResult<DomainRegistration>> {
  const url = `https://rdap.org/domain/${domain}`;
  try {
    const data = await withRetry(
      async (signal) => {
        const response = await fetch(url, {
          signal,
          headers: { Accept: 'application/rdap+json' },
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);
        return (await response.json()) as { events?: RdapEvent[]; entities?: RdapEntity[] };
      },
      { service: 'rdap', timeoutMs: 15_000 },
    );

    const findEvent = (action: string): string | null => {
      const event = (data.events ?? []).find((e) => e.eventAction === action);
      return event?.eventDate?.slice(0, 10) ?? null;
    };

    const registrarEntity = (data.entities ?? []).find((entity) =>
      (entity.roles ?? []).includes('registrar'),
    );
    const fnField = registrarEntity?.vcardArray?.[1]?.find((field) => field[0] === 'fn');
    const registrar = typeof fnField?.[3] === 'string' ? fnField[3] : null;

    const registered = findEvent('registration');
    const domainAgeYears = registered
      ? Math.floor((Date.now() - new Date(registered).getTime()) / (365.25 * 24 * 3600 * 1000))
      : null;

    return ok(
      {
        registered,
        expires: findEvent('expiration'),
        lastChanged: findEvent('last changed'),
        registrar,
        domainAgeYears,
      },
      url,
    );
  } catch (err) {
    return fail('rdap', url, err);
  }
}
