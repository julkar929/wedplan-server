import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(5000),
  CLIENT_URL: z.string().url(),
  SERVER_URL: z.string().url().default('http://localhost:5000'),
  MONGODB_URI: z.string().min(10, 'MONGODB_URI is required'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PREMIUM_PRICE_ID: z.string().default(''),
  PREMIUM_PRICE_USD: z.coerce.number().positive().default(29),
  IMGBB_API_KEY: z.string().default(''),
  ADMIN_EMAIL: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
  ADMIN_NAME: z.string().default('WedPlan Admin'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}

export const env = { ...parsed.data, isProduction };

if (isProduction) {
  const missing = (['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'IMGBB_API_KEY'] as const).filter(
    (k) => !env[k]
  );
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
}
