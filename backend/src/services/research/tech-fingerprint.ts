import { makeEvidence, type CrawledPage, type EvidenceItem } from './types';

interface Signature {
  technology: string;
  category: string;
  html?: RegExp;
  header?: [string, RegExp];
}

const SIGNATURES: Signature[] = [
  { technology: 'WordPress', category: 'CMS', html: /wp-content|wp-includes|wp-json|generator["' ]+content=["']WordPress/i },
  { technology: 'WooCommerce', category: 'E-commerce', html: /woocommerce/i },
  { technology: 'Shopify', category: 'E-commerce', html: /cdn\.shopify\.com|myshopify\.com/i },
  { technology: 'Webflow', category: 'Website builder', html: /assets(-global)?\.website-files\.com|data-wf-page/i },
  { technology: 'Wix', category: 'Website builder', html: /static\.wixstatic\.com|wix\.com/i },
  { technology: 'Squarespace', category: 'Website builder', html: /squarespace\.com|squarespace-cdn/i },
  { technology: 'Next.js', category: 'Framework', html: /\/_next\/static|__NEXT_DATA__/i },
  { technology: 'React', category: 'Framework', html: /data-reactroot|react-dom(\.production)?(\.min)?\.js/i },
  { technology: 'Vue.js', category: 'Framework', html: /data-v-app|vue(\.runtime)?(\.global)?(\.min)?\.js/i },
  { technology: 'Angular', category: 'Framework', html: /ng-version=/i },
  { technology: 'Nuxt.js', category: 'Framework', html: /__nuxt/i },
  { technology: 'Gatsby', category: 'Framework', html: /gatsby-/i },
  { technology: 'Laravel', category: 'Backend', html: /laravel_session|XSRF-TOKEN/i },
  { technology: 'PHP', category: 'Backend', header: ['x-powered-by', /php/i] },
  { technology: 'ASP.NET', category: 'Backend', header: ['x-powered-by', /asp\.net/i] },
  { technology: 'Express (Node.js)', category: 'Backend', header: ['x-powered-by', /express/i] },
  { technology: 'Cloudflare', category: 'CDN/Security', header: ['server', /cloudflare/i] },
  { technology: 'AWS CloudFront', category: 'CDN', header: ['x-amz-cf-id', /.+/] },
  { technology: 'Vercel', category: 'Hosting', header: ['x-vercel-id', /.+/] },
  { technology: 'Netlify', category: 'Hosting', header: ['x-nf-request-id', /.+/] },
  { technology: 'Fastly', category: 'CDN', header: ['x-served-by', /cache-/i] },
  { technology: 'LiteSpeed', category: 'Server', header: ['server', /litespeed/i] },
  { technology: 'nginx', category: 'Server', header: ['server', /nginx/i] },
  { technology: 'Apache', category: 'Server', header: ['server', /apache/i] },
  { technology: 'Google Tag Manager', category: 'Analytics', html: /googletagmanager\.com/i },
  { technology: 'Google Analytics', category: 'Analytics', html: /google-analytics\.com|gtag\(/i },
  { technology: 'Meta Pixel', category: 'Analytics', html: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(/i },
  { technology: 'Hotjar', category: 'Analytics', html: /static\.hotjar\.com/i },
  { technology: 'Microsoft Clarity', category: 'Analytics', html: /clarity\.ms/i },
  { technology: 'HubSpot', category: 'Marketing/CRM', html: /js\.hs-scripts\.com|hubspot/i },
  { technology: 'Mailchimp', category: 'Marketing', html: /chimpstatic|list-manage\.com/i },
  { technology: 'Intercom', category: 'Chat', html: /widget\.intercom\.io/i },
  { technology: 'Crisp Chat', category: 'Chat', html: /client\.crisp\.chat/i },
  { technology: 'Tawk.to', category: 'Chat', html: /embed\.tawk\.to/i },
  { technology: 'Zendesk', category: 'Support', html: /zdassets\.com/i },
  { technology: 'jQuery', category: 'Library', html: /jquery([.-])/i },
  { technology: 'Bootstrap', category: 'CSS framework', html: /bootstrap(\.min)?\.(css|js)/i },
  { technology: 'Tailwind CSS', category: 'CSS framework', html: /tailwind|class=["'][^"']*(?:flex items-center|mx-auto max-w)/i },
  { technology: 'Google Fonts', category: 'Fonts', html: /fonts\.googleapis\.com/i },
  { technology: 'Elementor', category: 'Page builder', html: /elementor/i },
  { technology: 'Stripe', category: 'Payments', html: /js\.stripe\.com/i },
  { technology: 'PayPal', category: 'Payments', html: /paypal\.com\/sdk/i },
  { technology: 'Razorpay', category: 'Payments', html: /checkout\.razorpay\.com/i },
  { technology: 'Mercado Pago', category: 'Payments', html: /mercadopago/i },
];

/**
 * Deterministic tech fingerprinting over headers + HTML of crawled pages.
 * Runs on every crawl — tech stack is never skipped when a site was reached.
 */
export function fingerprintTechStack(pages: CrawledPage[]): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const detected = new Set<string>();
  const home = pages.find((p) => p.kind === 'home') ?? pages[0];
  if (!home) return evidence;

  const samplePages = pages.slice(0, 6);
  for (const sig of SIGNATURES) {
    if (detected.has(sig.technology)) continue;
    for (const page of samplePages) {
      let matchText: string | null = null;
      if (sig.html) {
        const m = page.html.match(sig.html);
        if (m) matchText = m[0].slice(0, 120);
      }
      if (!matchText && sig.header) {
        const value = page.headers[sig.header[0]];
        if (value && sig.header[1].test(value)) matchText = `${sig.header[0]}: ${value.slice(0, 80)}`;
      }
      if (matchText) {
        detected.add(sig.technology);
        evidence.push(
          makeEvidence({
            field: 'tech_stack',
            value: sig.technology,
            sourceUrl: page.finalUrl,
            pageUrl: page.finalUrl,
            sourceType: 'official_website',
            extractedBy: 'tech_fingerprint',
            confidence: 0.9,
            evidenceText: matchText,
            metadata: { category: sig.category },
          }),
        );
        break;
      }
    }
  }

  // meta generator catches anything the signature table misses
  const generator = home.meta['generator'];
  if (generator && !detected.has(generator)) {
    evidence.push(
      makeEvidence({
        field: 'tech_stack',
        value: generator,
        sourceUrl: home.finalUrl,
        pageUrl: home.finalUrl,
        sourceType: 'official_website',
        extractedBy: 'tech_fingerprint',
        confidence: 0.85,
        evidenceText: `meta generator: ${generator}`,
        metadata: { category: 'Generator' },
      }),
    );
  }

  if (evidence.length === 0) {
    const server = home.headers.server;
    evidence.push(
      makeEvidence({
        field: 'tech_stack',
        value: server ? `Undetected stack (${server})` : 'Undetected static website',
        sourceUrl: home.finalUrl,
        pageUrl: home.finalUrl,
        sourceType: 'official_website',
        extractedBy: 'tech_fingerprint',
        confidence: 0.5,
        verified: 'low_confidence',
        evidenceText: server ? `server: ${server}` : 'website crawled but no known technology signature matched',
        metadata: { category: 'Unknown' },
      }),
    );
  }

  return evidence;
}
