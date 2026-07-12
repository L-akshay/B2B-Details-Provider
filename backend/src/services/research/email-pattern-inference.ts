import { makeEvidence, type EvidenceItem } from './types';

/**
 * Deterministic email-pattern inference (no API, no network). Given the REAL
 * emails already harvested from the company's own domain and the people we've
 * discovered, learn the domain's personal-email format and generate candidate
 * addresses for each named person.
 *
 * Every generated address is CANDIDATE data: confidence capped at 0.45,
 * verified = low_confidence, metadata.inferred = true. It surfaces under
 * "Found but Unverified" so a user can act on it, and it is NEVER presented as
 * a confirmed contact. We only infer when a real PERSONAL email proves the
 * domain issues personal addresses — we don't guess a pattern out of thin air.
 */

const ROLE_LOCALPARTS =
  /^(info|contact|contacto|ventas|sales|soporte|support|hola|hello|admin|administracion|postventa|rh|hr|marketing|prensa|press|legal|privacidad|privacy|no-?reply|noreply|webmaster|office|team|help|ayuda|facturacion|billing|cobranza|compras|purchasing|general|mail|correo)$/i;

type Pattern = 'first.last' | 'flast' | 'first_last' | 'firstl' | 'first' | 'last' | 'f.last';

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function nameParts(fullName: string): { first: string; last: string } | null {
  const words = stripAccents(fullName.trim().toLowerCase())
    .split(/\s+/)
    .filter((w) => /^[a-z][a-z'-]+$/.test(w) && w.length >= 2);
  if (words.length < 2) return null;
  // Spanish names often have two surnames — use first given + first surname
  return { first: words[0]!, last: words[words.length === 2 ? 1 : words.length - 2]! };
}

function buildLocalpart(pattern: Pattern, first: string, last: string): string {
  switch (pattern) {
    case 'first.last':
      return `${first}.${last}`;
    case 'first_last':
      return `${first}_${last}`;
    case 'f.last':
      return `${first[0]}.${last}`;
    case 'flast':
      return `${first[0]}${last}`;
    case 'firstl':
      return `${first}${last[0]}`;
    case 'first':
      return first;
    case 'last':
      return last;
  }
}

/** Detect which pattern a real personal localpart follows, given known people. */
function detectPattern(localpart: string, people: Array<{ first: string; last: string }>): Pattern | null {
  const lp = stripAccents(localpart.toLowerCase());
  const patterns: Pattern[] = ['first.last', 'first_last', 'f.last', 'flast', 'firstl', 'first', 'last'];
  for (const person of people) {
    for (const pattern of patterns) {
      if (buildLocalpart(pattern, person.first, person.last) === lp) return pattern;
    }
  }
  // No name match, but infer shape from structure (weaker signal)
  if (lp.includes('.')) return 'first.last';
  if (lp.includes('_')) return 'first_last';
  return null;
}

export function inferEmailCandidates(
  selectedDomain: string | undefined,
  harvestedEmails: EvidenceItem[],
  peopleNames: string[],
): EvidenceItem[] {
  if (!selectedDomain) return [];
  const people = peopleNames.map(nameParts).filter((p): p is { first: string; last: string } => p !== null);
  if (people.length === 0) return [];

  // Real personal emails ON the company domain (roles excluded) prove the format
  const domainEmails = harvestedEmails
    .filter((e) => e.field === 'email' && e.value.endsWith(`@${selectedDomain}`))
    .map((e) => e.value.toLowerCase());
  const personal = domainEmails
    .map((e) => e.split('@')[0]!)
    .filter((lp) => !ROLE_LOCALPARTS.test(lp) && !/^\d+$/.test(lp));
  if (personal.length === 0) return [];

  // Learn the pattern from the first personal email we can classify
  let pattern: Pattern | null = null;
  let patternSource = '';
  for (const lp of personal) {
    pattern = detectPattern(lp, people);
    if (pattern) {
      patternSource = `${lp}@${selectedDomain}`;
      break;
    }
  }
  if (!pattern) return [];

  const evidence: EvidenceItem[] = [];
  const seen = new Set(domainEmails);
  for (const person of people) {
    const candidate = `${buildLocalpart(pattern, person.first, person.last)}@${selectedDomain}`.toLowerCase();
    if (seen.has(candidate)) continue; // already a real, harvested email
    seen.add(candidate);
    evidence.push(
      makeEvidence({
        field: 'email',
        value: candidate,
        normalizedValue: candidate,
        sourceUrl: `https://${selectedDomain}`,
        sourceType: 'manual_fallback',
        extractedBy: 'regex',
        confidence: 0.45,
        verified: 'low_confidence',
        evidenceText: `Pattern-inferred (UNVERIFIED) from the domain format ${patternSource}. Verify before use.`,
        metadata: { inferred: true, pattern, patternSource, forPerson: `${person.first} ${person.last}` },
      }),
    );
    if (evidence.length >= 15) break;
  }
  return evidence;
}
