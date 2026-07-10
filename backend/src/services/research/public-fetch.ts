import { Agent } from 'undici';

/**
 * Many small/WordPress company sites ship an incomplete TLS chain (missing
 * intermediate cert). Browsers and curl recover via AIA fetching; Node's
 * undici rejects with "unable to verify the first certificate" and the crawl
 * gets nothing. This dispatcher relaxes chain verification for PUBLIC,
 * READ-ONLY page fetches only — never used for API calls that carry secrets.
 */
export const publicFetchAgent = new Agent({
  connect: { rejectUnauthorized: false },
  connectTimeout: 15_000,
});

export const PUBLIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** fetch() for public pages, tolerant of incomplete TLS chains. */
export function publicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    // @ts-expect-error undici dispatcher is a valid Node fetch option
    dispatcher: publicFetchAgent,
    headers: { 'User-Agent': PUBLIC_UA, ...init.headers },
  });
}
