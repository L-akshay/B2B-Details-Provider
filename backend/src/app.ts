import cors from 'cors';
import express from 'express';
import { requireAccessPassword } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health';
import { researchRouter } from './routes/research';

export function createApp(): express.Express {
  const app = express();

  // Render terminates TLS behind a proxy; required for per-IP rate limiting
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));

  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use('/api/research', requireAccessPassword, researchRouter);

  app.use(errorHandler);
  return app;
}
