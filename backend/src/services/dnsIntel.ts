import { resolveMx, resolveNs, resolveTxt } from 'node:dns/promises';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface DnsIntel {
  mxHosts: string[];
  emailProvider: string | null;
  nameservers: string[];
  saasHints: string[];
}

const MX_PROVIDERS: Array<[RegExp, string]> = [
  [/google|googlemail/i, 'Google Workspace'],
  [/outlook|protection\.outlook/i, 'Microsoft 365'],
  [/zoho/i, 'Zoho Mail'],
  [/proton/i, 'Proton Mail'],
  [/pphosted|proofpoint/i, 'Proofpoint (enterprise mail security)'],
  [/mimecast/i, 'Mimecast (enterprise mail security)'],
  [/barracuda/i, 'Barracuda (mail security)'],
  [/secureserver/i, 'GoDaddy Email'],
  [/yandex/i, 'Yandex Mail'],
  [/mailgun/i, 'Mailgun'],
  [/improvmx/i, 'ImprovMX forwarding'],
];

const TXT_HINTS: Array<[RegExp, string]> = [
  [/google-site-verification/i, 'Google services (Search Console / Workspace)'],
  [/^ms=|microsoft/i, 'Microsoft 365'],
  [/facebook-domain-verification/i, 'Meta Business'],
  [/stripe-verification/i, 'Stripe'],
  [/atlassian-domain-verification/i, 'Atlassian'],
  [/zoom/i, 'Zoom'],
  [/docusign/i, 'DocuSign'],
  [/hubspot/i, 'HubSpot'],
  [/shopify/i, 'Shopify'],
  [/openai-domain-verification/i, 'OpenAI'],
  [/canva-site-verification/i, 'Canva'],
  [/adobe/i, 'Adobe'],
  [/include:_spf\.google\.com/i, 'Sends mail via Google'],
  [/include:.*\.outlook\.com/i, 'Sends mail via Microsoft 365'],
  [/include:.*sendgrid/i, 'SendGrid'],
  [/include:.*mailchimp|servers\.mcsv\.net/i, 'Mailchimp'],
  [/include:.*amazonses|amazonses\.com/i, 'Amazon SES'],
  [/include:.*zoho/i, 'Sends mail via Zoho'],
];

/**
 * DNS reconnaissance — free signal about a company's email provider and SaaS
 * footprint from MX/TXT/NS records (feeds the tech-stack section).
 */
export async function dnsIntel(domain: string): Promise<ServiceResult<DnsIntel>> {
  const sourceUrl = `dns:${domain}`;
  try {
    const [mxResult, txtResult, nsResult] = await Promise.allSettled([
      resolveMx(domain),
      resolveTxt(domain),
      resolveNs(domain),
    ]);

    const mxHosts =
      mxResult.status === 'fulfilled'
        ? mxResult.value.sort((a, b) => a.priority - b.priority).map((mx) => mx.exchange)
        : [];
    const txtRecords =
      txtResult.status === 'fulfilled' ? txtResult.value.map((chunks) => chunks.join('')) : [];
    const nameservers = nsResult.status === 'fulfilled' ? nsResult.value : [];

    if (mxHosts.length === 0 && txtRecords.length === 0 && nameservers.length === 0) {
      throw new Error(`no DNS records resolved for ${domain}`);
    }

    const emailProvider =
      MX_PROVIDERS.find(([pattern]) => mxHosts.some((host) => pattern.test(host)))?.[1] ?? null;

    const saasHints = [
      ...new Set(
        txtRecords.flatMap((record) =>
          TXT_HINTS.filter(([pattern]) => pattern.test(record)).map(([, hint]) => hint),
        ),
      ),
    ];

    return ok({ mxHosts, emailProvider, nameservers, saasHints }, sourceUrl);
  } catch (err) {
    return fail('dns-intel', sourceUrl, err);
  }
}
