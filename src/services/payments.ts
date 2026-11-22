import { env } from '../config/env.js';
import { transactions, users, type UserDoc } from '../db.js';
import { ConflictError, ForbiddenError } from '../lib/errors.js';
import { requireStripe } from '../lib/stripe.js';
import { toTransactionDTO } from './admin.js';
import { isPremiumActive } from './subscription.js';

export async function startPremiumCheckout(vendor: UserDoc) {
  if (vendor.role !== 'vendor') throw new ForbiddenError('Only Vendor accounts can subscribe to Premium.');
  if (isPremiumActive(vendor)) throw new ConflictError('Your vendor account already has an active Premium subscription.');
  const stripe = requireStripe();
  const vendorId = String(vendor._id); // always the authenticated vendor — never a client-supplied id

  const lineItem = env.STRIPE_PREMIUM_PRICE_ID
    ? { price: env.STRIPE_PREMIUM_PRICE_ID, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: 'usd',
          recurring: { interval: 'month' as const },
          unit_amount: Math.round(env.PREMIUM_PRICE_USD * 100),
          product_data: { name: 'WedPlan Vendor Premium', description: 'Unlimited active services and Premium Vendor badge.' },
        },
      };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: vendor.email,
    client_reference_id: vendorId,
    line_items: [lineItem],
    metadata: { vendorId, plan: 'Premium' },
    subscription_data: { metadata: { vendorId, plan: 'Premium' } },
    success_url: `${env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.CLIENT_URL}/payment/cancel`,
  });

  await transactions().insertOne({
    vendorId,
    plan: 'Premium',
    amount: env.PREMIUM_PRICE_USD,
    currency: 'usd',
    stripeSessionId: session.id,
    status: 'Pending',
    createdAt: new Date(),
  } as never);

  return { sessionId: session.id, checkoutUrl: session.url! };
}

/** Read-only view for the success page. It can never grant Premium: only the webhook does. */
export async function sessionStatus(vendor: UserDoc, sessionId: string) {
  const tx = await transactions().findOne({ stripeSessionId: sessionId });
  if (tx && tx.vendorId !== String(vendor._id)) throw new ForbiddenError('You cannot inspect another vendor’s payment session.');
  const fresh = await users().findOne({ _id: vendor._id });
  return {
    transaction: tx ? toTransactionDTO(tx) : null,
    premiumActive: fresh ? isPremiumActive(fresh) : false,
  };
}

export async function cancelSubscription(vendor: UserDoc) {
  if (!vendor.stripeSubscriptionId || !isPremiumActive(vendor)) {
    throw new ConflictError('You do not have an active Premium subscription to cancel.');
  }
  const stripe = requireStripe();
  // Access continues until the paid period ends; the webhook flips the final state.
  await stripe.subscriptions.update(vendor.stripeSubscriptionId, { cancel_at_period_end: true });
  await users().updateOne({ _id: vendor._id }, { $set: { cancelAtPeriodEnd: true, updatedAt: new Date() } });
  return { cancelAtPeriodEnd: true, accessUntil: vendor.subscriptionExpiresAt ? new Date(vendor.subscriptionExpiresAt).toISOString() : null };
}

export async function listVendorTransactions(vendorId: string) {
  const rows = await transactions().find({ vendorId }).sort({ createdAt: -1 }).toArray();
  return rows.map((t) => toTransactionDTO(t));
}
