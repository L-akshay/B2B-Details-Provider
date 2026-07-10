import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Shared-password gate for all /api routes. The frontend sends the password
 * in the x-access-password header on every request.
 */
export function requireAccessPassword(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) {
    res.status(503).json({ error: 'Server misconfigured: ACCESS_PASSWORD is not set' });
    return;
  }

  const provided = req.header('x-access-password') ?? '';
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  const valid =
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer);

  if (!valid) {
    res.status(401).json({ error: 'Invalid or missing access password' });
    return;
  }
  next();
}
