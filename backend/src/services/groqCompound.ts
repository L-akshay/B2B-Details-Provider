import { GROQ_COMPOUND_MODEL, groqChat } from '../lib/groq';
import { fail, normalizeDomain, ok } from '../lib/serviceResult';
import type { ServiceResult } from '../types/schema';

export interface CompoundResearch {
  digest: string;
  domain: string | null;
  linkedinUrl: string | null;
}

const SOURCE = 'groq/compound (web search grounding)';

/**
 * Web-search grounding pass: groq/compound searches the live web and returns
 * a cited research digest plus two machine-readable footer lines used for
 * domain / LinkedIn resolution.
 */
export async function compoundResearch(
  companyName: string,
  extraInfo?: string,
  searchName?: string,
): Promise<ServiceResult<CompoundResearch>> {
  const prompt = `Research the company "${companyName}"${
    searchName && searchName !== companyName ? ` (trade name / search as: "${searchName}")` : ''
  }.${extraInfo ? ` Additional context from the requester: ${extraInfo}.` : ''}

Use web search to find, with a source URL cited next to every fact:
1. The official website domain.
2. The official LinkedIn company page URL.
3. Full legal/registered name and any tax/registration identifiers that are public.
4. Headquarters address and any office addresses.
5. Publicly listed phone numbers.
6. Industry, founding year, employee count.
7. Key people (founders, CEO, leadership) with roles.
8. Certifications or notable accreditations.
9. 3-5 recent news items (headline, URL, date).

Only report facts you actually found in search results — write "not found" for anything you could not verify. Never guess.

After the digest, end your reply with exactly these two lines (use "unknown" if not found):
OFFICIAL_DOMAIN: <bare domain like example.com>
LINKEDIN_URL: <full url>`;

  try {
    let digest: string;
    try {
      digest = await groqChat({
        service: 'groq-compound',
        model: GROQ_COMPOUND_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        timeoutMs: 120_000,
      });
    } catch {
      // compound's internal search context can blow free-tier request
      // limits (413); compound-mini is lighter and shares the same tooling
      digest = await groqChat({
        service: 'groq-compound-mini',
        model: 'groq/compound-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        timeoutMs: 120_000,
      });
    }

    const domainMatch = digest.match(/OFFICIAL_DOMAIN:\s*(\S+)/i);
    const linkedinMatch = digest.match(/LINKEDIN_URL:\s*(\S+)/i);
    const linkedinRaw = linkedinMatch?.[1] ?? '';

    return ok(
      {
        digest,
        domain: domainMatch?.[1] ? normalizeDomain(domainMatch[1]) : null,
        linkedinUrl: /linkedin\.com/i.test(linkedinRaw) ? linkedinRaw : null,
      },
      SOURCE,
    );
  } catch (err) {
    return fail('groq-compound', SOURCE, err);
  }
}
