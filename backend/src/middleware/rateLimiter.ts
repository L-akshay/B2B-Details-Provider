import rateLimit from 'express-rate-limit';

/**
 * Each research run fans out to multiple paid APIs (Groq, Gemini, Firecrawl,
 * Hunter, Google CSE), so the ceiling is deliberately low.
 */
export const researchRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded: max 10 research requests per hour per IP.' },
});
