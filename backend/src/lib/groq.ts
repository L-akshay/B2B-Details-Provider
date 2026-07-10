import { withRetry } from './retry';

export const GROQ_COMPOUND_MODEL = 'groq/compound';
export const GROQ_EXTRACTION_MODEL = 'openai/gpt-oss-120b';
/** Separate free-tier quota bucket — keeps extraction alive when gpt-oss is exhausted */
export const GROQ_FALLBACK_MODEL = 'llama-3.3-70b-versatile';

interface GroqChatOptions {
  service: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Force valid-JSON output without the token overhead of a full schema */
  jsonObject?: boolean;
}

export async function groqChat(opts: GroqChatOptions): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  return withRetry(
    async (signal) => {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 8192,
          ...(opts.jsonObject ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Groq HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('Groq returned an empty completion');
      return content;
    },
    { service: opts.service, timeoutMs: opts.timeoutMs ?? 60_000 },
  );
}
