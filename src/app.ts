import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { env } from './config/env.js';
import { handleStripeEvent } from './services/stripeEvents.js';
import { constructWebhookEvent } from './lib/stripe.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createApiRouter } from './routes/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: [env.CLIENT_URL], credentials: true, allowedHeaders: ['Content-Type', 'Authorization'] }));

  // 1) Stripe webhook: RAW body required for signature verification. Registered BEFORE express.json().
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = constructWebhookEvent(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
    } catch (e: any) {
      if (e?.status === 503) return res.status(503).json({ error: e.message });
      return res.status(400).json({ error: 'Webhook signature verification failed.' });
    }
    try {
      const result = await handleStripeEvent(event);
      res.json({ received: true, ...result });
    } catch (e) {
      console.error('[Stripe webhook handler error]', e);
      res.status(500).json({ error: 'Webhook handler failed.' }); // Stripe will retry
    }
  });

  // 2) Better Auth (sign-in/up, Google OAuth callback, session, JWT /token & /jwks). Must precede express.json().
  const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
    skip: (req) => req.method === 'GET', message: { error: 'Too many attempts. Please try again in a few minutes.' } });
  app.use('/api/auth', authLimiter);
  app.all('/api/auth/*', toNodeHandler(auth));

  // 3) JSON API
  app.use(express.json({ limit: '8mb' }));
  app.use('/api', createApiRouter());
  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
