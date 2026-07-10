import { withRetry } from '../lib/retry';
import { fail, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';
import type { DnsIntel } from './dnsIntel';

const HTML_SIGNATURES: Array<[RegExp, string]> = [
  [/wp-content|wp-includes|wp-json/i, 'WordPress'],
  [/cdn\.shopify\.com|x-shopify/i, 'Shopify'],
  [/__NEXT_DATA__|\/_next\/static/i, 'Next.js'],
  [/static\.wixstatic\.com|wix\.com/i, 'Wix'],
  [/squarespace\.com|squarespace-cdn/i, 'Squarespace'],
  [/assets(-global)?\.website-files\.com|webflow/i, 'Webflow'],
  [/gatsby-/i, 'Gatsby'],
  [/__nuxt|nuxt\.config/i, 'Nuxt.js'],
  [/data-reactroot|react-dom(\.production)?(\.min)?\.js/i, 'React'],
  [/ng-version=/i, 'Angular'],
  [/data-v-app|vue(\.runtime)?(\.global)?(\.min)?\.js/i, 'Vue.js'],
  [/jquery([.-])/i, 'jQuery'],
  [/bootstrap(\.min)?\.(css|js)/i, 'Bootstrap'],
  [/googletagmanager\.com/i, 'Google Tag Manager'],
  [/google-analytics\.com|gtag\(/i, 'Google Analytics'],
  [/js\.hs-scripts\.com|hubspot/i, 'HubSpot'],
  [/widget\.intercom\.io|intercomcdn/i, 'Intercom'],
  [/client\.crisp\.chat/i, 'Crisp Chat'],
  [/embed\.tawk\.to/i, 'Tawk.to Chat'],
  [/zdassets\.com|zendesk/i, 'Zendesk'],
  [/static\.hotjar\.com/i, 'Hotjar'],
  [/clarity\.ms/i, 'Microsoft Clarity'],
  [/checkout\.razorpay\.com|razorpay/i, 'Razorpay'],
  [/js\.stripe\.com/i, 'Stripe'],
  [/paypal\.com\/sdk/i, 'PayPal'],
  [/static\.klaviyo\.com/i, 'Klaviyo'],
  [/typeform\.com/i, 'Typeform'],
  [/calendly\.com/i, 'Calendly'],
  [/fonts\.googleapis\.com/i, 'Google Fonts'],
  [/cdn\.segment\.com/i, 'Segment'],
  [/cloudflareinsights\.com/i, 'Cloudflare Analytics'],
];

const HEADER_SIGNATURES: Array<[string, RegExp, string]> = [
  ['server', /cloudflare/i, 'Cloudflare'],
  ['server', /litespeed/i, 'LiteSpeed'],
  ['server', /nginx/i, 'nginx'],
  ['server', /apache/i, 'Apache'],
  ['x-vercel-id', /.+/, 'Vercel'],
  ['x-powered-by', /express/i, 'Express (Node.js)'],
  ['x-powered-by', /php/i, 'PHP'],
  ['x-powered-by', /asp\.net/i, 'ASP.NET'],
  ['x-powered-by', /next\.js/i, 'Next.js'],
  ['x-served-by', /fastly|cache-/i, 'Fastly CDN'],
  ['x-amz-cf-id', /.+/, 'AWS CloudFront'],
  ['x-nf-request-id', /.+/, 'Netlify'],
  ['fly-request-id', /.+/, 'Fly.io'],
  ['x-render-origin-server', /.+/, 'Render'],
  ['x-github-request-id', /.+/, 'GitHub Pages'],
  ['x-shopify-stage', /.+/, 'Shopify'],
];

const NS_SIGNATURES: Array<[RegExp, string]> = [
  [/cloudflare/i, 'Cloudflare DNS'],
  [/awsdns/i, 'AWS Route 53'],
  [/domaincontrol/i, 'GoDaddy DNS'],
  [/googledomains|google\.com/i, 'Google DNS'],
  [/vercel-dns/i, 'Vercel DNS'],
];

/**
 * Tech-stack fingerprinting from HTML content, HTTP response headers, meta
 * generator tags, and DNS. Replaces the discontinued Wappalyzer package with
 * zero-cost signature matching.
 */
export async function detectTechStack(
  domain: string,
  homepageHtml: string | null,
  dns: DnsIntel | null,
): Promise<ServiceResult<string[]>> {
  const sourceUrl = `https://${domain}`;
  try {
    const detected = new Set<string>();

    let headers: Headers | null = null;
    try {
      headers = await withRetry(
        async (signal) => {
          const response = await fetch(sourceUrl, {
            signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; company-research-tool/1.0)' },
          });
          return response.headers;
        },
        { service: 'tech-stack-headers', timeoutMs: 12_000, retries: 1 },
      );
    } catch {
      // headers are one of several signal sources; HTML/DNS still apply
    }

    if (headers) {
      for (const [name, pattern, tech] of HEADER_SIGNATURES) {
        const value = headers.get(name);
        if (value && pattern.test(value)) detected.add(tech);
      }
    }

    if (homepageHtml) {
      for (const [pattern, tech] of HTML_SIGNATURES) {
        if (pattern.test(homepageHtml)) detected.add(tech);
      }
      const generator = homepageHtml.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
      if (generator?.[1]) detected.add(generator[1].trim());
    }

    if (dns) {
      if (dns.emailProvider) detected.add(`Email: ${dns.emailProvider}`);
      for (const [pattern, tech] of NS_SIGNATURES) {
        if (dns.nameservers.some((ns) => pattern.test(ns))) detected.add(tech);
      }
      for (const hint of dns.saasHints) detected.add(hint);
    }

    if (detected.size === 0) throw new Error('no technology signatures matched');
    return ok([...detected].sort(), sourceUrl);
  } catch (err) {
    return fail('tech-stack', sourceUrl, err);
  }
}
