import type Stripe from 'stripe';
import { toOid, transactions, users, type UserDoc } from '../db.js';
import { activatePremium, downgradeToFree } from './subscription.js';

const DAY = 24 * 60 * 60 * 1000;

async function findVendor(opts: { vendorId?: string | null; subscriptionId?: string | null; customerId?: string | null }): Promise<UserDoc | null> {
  if (opts.subscriptionId) {
    const u = await users().findOne({ stripeSubscriptionId: opts.subscriptionId });
    if (u) return u;
  }
  if (opts.customerId) {
    const u = await users().findOne({ stripeCustomerId: opts.customerId });
    if (u) return u;
  }
  const oid = opts.vendorId ? toOid(opts.vendorId) : null;
  return oid ? users().findOne({ _id: oid, role: 'vendor' }) : null;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id ?? null);

/**
 * Processes ONLY events whose signature has already been verified (see routes/webhook.ts).
 * Every branch is idempotent so Stripe retries / duplicate deliveries are harmless.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode !== 'subscription') return { handled: false };
      if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { handled: false };
      const vendorId = s.metadata?.vendorId || s.client_reference_id;
      const subscriptionId = idOf(s.subscription);
      const customerId = idOf(s.customer);
      const vendor = await findVendor({ vendorId, subscriptionId, customerId });
      if (!vendor) return { handled: false };

      const amount = (s.amount_total ?? 0) / 100;
      await transactions().updateOne(
        { stripeSessionId: s.id },
        {
          $set: { status: 'Succeeded', stripeSubscriptionId: subscriptionId, currency: s.currency ?? 'usd', ...(amount ? { amount } : {}) },
          $setOnInsert: { vendorId: String(vendor._id), plan: 'Premium', createdAt: new Date(), ...(amount ? {} : { amount: 0 }) },
        } as never,
        { upsert: true }
      );
      // Provisional expiry until `invoice.paid` supplies the exact period end (never shortens a later one)
      const current = vendor.subscriptionExpiresAt ? new Date(vendor.subscriptionExpiresAt).getTime() : 0;
      const provisional = Date.now() + 35 * DAY;
      await activatePremium(String(vendor._id), {
        expiresAt: new Date(Math.max(current, provisional)),
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      });
      return { handled: true };
    }

    case 'checkout.session.expired': {
      const s = event.data.object as Stripe.Checkout.Session;
      await transactions().updateOne({ stripeSessionId: s.id, status: 'Pending' }, { $set: { status: 'Failed' } });
      return { handled: true };
    }

    case 'invoice.paid': {
      const inv = event.data.object as any;
      const subscriptionId = idOf(inv.subscription ?? inv.parent?.subscription_details?.subscription);
      const meta = inv.subscription_details?.metadata ?? inv.parent?.subscription_details?.metadata ?? {};
      const vendor = await findVendor({ vendorId: meta.vendorId, subscriptionId, customerId: idOf(inv.customer) });
      if (!vendor) return { handled: false };
      const periodEnd = inv.lines?.data?.[0]?.period?.end;
      const expiresAt = periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 35 * DAY);
      if (expiresAt.getTime() > Date.now()) {
        await activatePremium(String(vendor._id), {
          expiresAt,
          stripeCustomerId: idOf(inv.customer),
          stripeSubscriptionId: subscriptionId,
        });
      }
      if (inv.billing_reason === 'subscription_cycle') {
        await transactions().updateOne(
          { stripeSessionId: `inv_${inv.id}` },
          {
            $setOnInsert: {
              vendorId: String(vendor._id), plan: 'Premium', amount: (inv.amount_paid ?? 0) / 100,
              currency: inv.currency ?? 'usd', stripeSessionId: `inv_${inv.id}`, stripeSubscriptionId: subscriptionId,
              status: 'Succeeded', createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
      return { handled: true };
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object as any;
      const subscriptionId = idOf(inv.subscription ?? inv.parent?.subscription_details?.subscription);
      const vendor = await findVendor({ subscriptionId, customerId: idOf(inv.customer) });
      if (!vendor) return { handled: false };
      await users().updateOne({ _id: vendor._id }, { $set: { subscriptionStatus: 'past_due', updatedAt: new Date() } });
      await transactions().updateOne(
        { stripeSessionId: `inv_${inv.id}` },
        {
          $setOnInsert: {
            vendorId: String(vendor._id), plan: 'Premium', amount: (inv.amount_due ?? 0) / 100, currency: inv.currency ?? 'usd',
            stripeSessionId: `inv_${inv.id}`, stripeSubscriptionId: subscriptionId, status: 'Failed', createdAt: new Date(),
          },
        },
        { upsert: true }
      );
      return { handled: true };
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const vendor = await findVendor({ vendorId: sub.metadata?.vendorId, subscriptionId: sub.id, customerId: idOf(sub.customer) });
      if (!vendor) return { handled: false };
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
        await downgradeToFree(String(vendor._id));
      } else {
        await users().updateOne(
          { _id: vendor._id },
          { $set: { cancelAtPeriodEnd: !!sub.cancel_at_period_end, subscriptionStatus: sub.status, updatedAt: new Date() } }
        );
      }
      return { handled: true };
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const vendor = await findVendor({ vendorId: sub.metadata?.vendorId, subscriptionId: sub.id, customerId: idOf(sub.customer) });
      if (!vendor) return { handled: false };
      await downgradeToFree(String(vendor._id));
      return { handled: true };
    }

    default:
      return { handled: false };
  }
}
