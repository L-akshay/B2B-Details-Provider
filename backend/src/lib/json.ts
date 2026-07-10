/**
 * Parses JSON from model output that may be wrapped in markdown fences or
 * surrounded by prose. Throws if no parseable object is found.
 */
export function parseJsonLenient<T>(raw: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`No JSON object found in model output: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(stripped.slice(start, end + 1)) as T;
  }
}
