import { promises as dns } from 'node:dns';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { makeEvidence, type EvidenceItem } from './types';

const MX_PROVIDERS: Array<[RegExp, string]> = [
  [/google|googlemail|aspmx/i, 'Google Workspace'],
  [/outlook|protection\.outlook|office365/i, 'Microsoft 365'],
  [/zoho/i, 'Zoho Mail'],
  [/proton/i, 'Proton Mail'],
  [/pphosted|proofpoint/i, 'Proofpoint'],
  [/mimecast/i, 'Mimecast'],
  [/secureserver/i, 'GoDaddy Email'],
  [/mailgun/i, 'Mailgun'],
  [/zohomail|zoho/i, 'Zoho Mail'],
  [/improvmx/i, 'ImprovMX'],
];

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, Array<[string, unknown, string, unknown]>];
}

/**
 * Domain-registration + DNS/email-infra facts via RDAP and Node DNS. Fully
 * deterministic; individual lookup failures degrade gracefully (RDAP doesn't
 * cover every ccTLD, e.g. .mx) without failing the job.
 */
export async function getRdapDnsEvidence(
  domain: string,
): Promise<{ evidence: EvidenceItem[]; errors: Record<string, string> }> {
  const evidence: EvidenceItem[] = [];
  const errors: Record<string, string> = {};
  const rdapUrl = `https://rdap.org/domain/${domain}`;
  const dnsSource = `dns:${domain}`;

  // RDAP
  try {
    const data = await withRetry(
      async (signal) => {
        const response = await fetch(rdapUrl, {
          signal,
          headers: { Accept: 'application/rdap+json' },
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);
        return (await response.json()) as { events?: RdapEvent[]; entities?: RdapEntity[] };
      },
      { service: 'rdap', timeoutMs: 15_000, retries: 1 },
    );

    const registered = (data.events ?? []).find((e) => e.eventAction === 'registration')?.eventDate;
    if (registered) {
      evidence.push(
        makeEvidence({
          field: 'domain_registered',
          value: registered.slice(0, 10),
          sourceUrl: rdapUrl,
          sourceType: 'rdap',
          extractedBy: 'rdap',
          confidence: 0.9,
          domain,
        }),
      );
    }
    const registrarEntity = (data.entities ?? []).find((e) => (e.roles ?? []).includes('registrar'));
    const fn = registrarEntity?.vcardArray?.[1]?.find((f) => f[0] === 'fn');
    if (fn && typeof fn[3] === 'string') {
      evidence.push(
        makeEvidence({
          field: 'registrar',
          value: fn[3],
          sourceUrl: rdapUrl,
          sourceType: 'rdap',
          extractedBy: 'rdap',
          confidence: 0.9,
          domain,
        }),
      );
    }
  } catch (err) {
    errors['rdap'] = err instanceof Error ? err.message : String(err);
  }

  // DNS: MX, TXT (SPF), DMARC, NS, A/AAAA/CNAME
  const [mx, txt, dmarc, ns, a, aaaa, cname] = await Promise.allSettled([
    dns.resolveMx(domain),
    dns.resolveTxt(domain),
    dns.resolveTxt(`_dmarc.${domain}`),
    dns.resolveNs(domain),
    dns.resolve4(domain),
    dns.resolve6(domain),
    dns.resolveCname(`www.${domain}`),
  ]);

  if (mx.status === 'fulfilled' && mx.value.length > 0) {
    const hosts = mx.value.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    evidence.push(
      makeEvidence({
        field: 'dns',
        value: `MX: ${hosts.join(', ')}`,
        sourceUrl: dnsSource,
        sourceType: 'dns',
        extractedBy: 'dns',
        confidence: 0.9,
        domain,
      }),
    );
    const provider = MX_PROVIDERS.find(([re]) => hosts.some((h) => re.test(h)))?.[1];
    if (provider) {
      evidence.push(
        makeEvidence({
          field: 'mx_provider',
          value: provider,
          sourceUrl: dnsSource,
          sourceType: 'dns',
          extractedBy: 'dns',
          confidence: 0.85,
          domain,
          evidenceText: hosts[0],
        }),
      );
    }
  } else if (mx.status === 'rejected') {
    errors['dns-mx'] = String(mx.reason);
  }

  if (txt.status === 'fulfilled') {
    const flat = txt.value.map((chunks) => chunks.join(''));
    const spf = flat.find((r) => /^v=spf1/i.test(r));
    if (spf) {
      evidence.push(
        makeEvidence({
          field: 'spf',
          value: spf,
          sourceUrl: dnsSource,
          sourceType: 'dns',
          extractedBy: 'dns',
          confidence: 0.9,
          domain,
        }),
      );
    }
  }

  if (dmarc.status === 'fulfilled') {
    const flat = dmarc.value.map((chunks) => chunks.join(''));
    const record = flat.find((r) => /^v=DMARC1/i.test(r));
    if (record) {
      evidence.push(
        makeEvidence({
          field: 'dmarc',
          value: record,
          sourceUrl: `dns:_dmarc.${domain}`,
          sourceType: 'dns',
          extractedBy: 'dns',
          confidence: 0.9,
          domain,
        }),
      );
    }
  }

  if (ns.status === 'fulfilled' && ns.value.length > 0) {
    evidence.push(
      makeEvidence({
        field: 'dns',
        value: `NS: ${ns.value.join(', ')}`,
        sourceUrl: dnsSource,
        sourceType: 'dns',
        extractedBy: 'dns',
        confidence: 0.85,
        domain,
      }),
    );
  }

  if (a.status === 'fulfilled' && a.value.length > 0) {
    evidence.push(
      makeEvidence({
        field: 'dns',
        value: `A: ${a.value.join(', ')}`,
        sourceUrl: dnsSource,
        sourceType: 'dns',
        extractedBy: 'dns',
        confidence: 0.85,
        domain,
      }),
    );
  }

  if (aaaa.status === 'fulfilled' && aaaa.value.length > 0) {
    evidence.push(
      makeEvidence({
        field: 'dns',
        value: `AAAA: ${aaaa.value.join(', ')}`,
        sourceUrl: dnsSource,
        sourceType: 'dns',
        extractedBy: 'dns',
        confidence: 0.85,
        domain,
      }),
    );
  }

  if (cname.status === 'fulfilled' && cname.value.length > 0) {
    evidence.push(
      makeEvidence({
        field: 'dns',
        value: `CNAME www: ${cname.value.join(', ')}`,
        sourceUrl: `dns:www.${domain}`,
        sourceType: 'dns',
        extractedBy: 'dns',
        confidence: 0.85,
        domain,
      }),
    );
  }

  logger.info({ domain, evidence: evidence.length, errors: Object.keys(errors) }, 'rdap/dns complete');
  return { evidence, errors };
}
