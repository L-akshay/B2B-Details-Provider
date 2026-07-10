import 'dotenv/config';
import { createApp } from './app';
import { logger } from './lib/logger';

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ACCESS_PASSWORD',
] as const;

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  logger.fatal({ missing }, 'refusing to start: required environment variables are not set');
  process.exit(1);
}

const port = Number(process.env.PORT) || 4000;

createApp().listen(port, () => {
  logger.info({ port }, 'company-research backend listening');
});
