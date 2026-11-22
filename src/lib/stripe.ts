import Stripe from 'stripe';
import { env } from '../config/env.js';
import { ServiceUnavailableError } from './errors.js';

/** Holder object so tests can swap the client. */
export const stripeHolder: { client: Stripe | null } = {
  client: env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null,
};

export function requireStripe(): Stripe {
  if (!stripeHolder.client) {
    throw new ServiceUnavailableError('Stripe is not configured on this server.');
  }
  return stripeHolder.client;
}

/** Signature verification works without an API key; it only needs the webhook signing secret. */
const verifier = new Stripe(env.STRIPE_SECRET_KEY || 'sk_test_webhook_verification_only');

export function constructWebhookEvent(rawBody: Buffer, signature: string | undefined, secret = env.STRIPE_WEBHOOK_SECRET): Stripe.Event {
  if (!secret) throw new ServiceUnavailableError('Stripe webhook secret is not configured.');
  if (!signature) throw new Error('Missing Stripe signature header.');
  return verifier.webhooks.constructEvent(rawBody, signature, secret);
}
