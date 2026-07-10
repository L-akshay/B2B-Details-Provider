import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

const researchRequestSchema = z.object({
  company_name: z
    .string({ required_error: 'company_name is required' })
    .trim()
    .min(2, 'company_name must be at least 2 characters')
    .max(200, 'company_name must be at most 200 characters'),
  extra_info: z.string().trim().max(2000, 'extra_info must be at most 2000 characters').optional(),
});

export type ResearchRequestBody = z.infer<typeof researchRequestSchema>;

export function validateResearchRequest(req: Request, res: Response, next: NextFunction): void {
  const parsed = researchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  req.body = parsed.data;
  next();
}
