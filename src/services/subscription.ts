import { services, toOid, users, type UserDoc } from '../db.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { FREE_PLAN_ACTIVE_LIMIT } from '../types.js';

export function isPremiumActive(u: Pick<UserDoc, 'subscriptionPlan' | 'subscriptionExpiresAt'>): boolean {
  if (u.subscriptionPlan !== 'Premium') return false;
  if (!u.subscriptionExpiresAt) return false; // Premium without an expiry is never trusted
  return new Date(u.subscriptionExpiresAt).getTime() > Date.now();
}

/** "Active" = counts toward the Free-plan cap: not rejected and not paused by the vendor. */
export async function countActiveServices(vendorId: string): Promise<number> {
  return services().countDocuments({ vendorId, status: { $ne: 'Rejected' }, isAvailable: true });
}

export async function assertCanHaveAnotherActiveService(vendor: UserDoc): Promise<void> {
  if (isPremiumActive(vendor)) return;
  const active = await countActiveServices(String(vendor._id));
  if (active >= FREE_PLAN_ACTIVE_LIMIT) {
    throw new ForbiddenError(
      `Free plan vendors can publish a maximum of ${FREE_PLAN_ACTIVE_LIMIT} active services. Upgrade to Premium for unlimited listings.`
    );
  }
}

/** Called ONLY from verified Stripe webhook handling (never from a client redirect). */
export async function activatePremium(
  vendorId: string,
  data: { expiresAt: Date; stripeCustomerId?: string | null; stripeSubscriptionId?: string | null }
): Promise<void> {
  const oid = toOid(vendorId);
  if (!oid) return;
  await users().updateOne(
    { _id: oid, role: 'vendor' },
    {
      $set: {
        subscriptionPlan: 'Premium',
        subscriptionExpiresAt: data.expiresAt,
        subscriptionStatus: 'active',
        updatedAt: new Date(),
        ...(data.stripeCustomerId ? { stripeCustomerId: data.stripeCustomerId } : {}),
        ...(data.stripeSubscriptionId ? { stripeSubscriptionId: data.stripeSubscriptionId } : {}),
      },
    }
  );
}

/** Downgrade and pause every active service beyond the newest FREE_PLAN_ACTIVE_LIMIT. */
export async function downgradeToFree(vendorId: string): Promise<void> {
  const oid = toOid(vendorId);
  if (!oid) return;
  await users().updateOne(
    { _id: oid },
    {
      $set: { subscriptionPlan: 'Free', cancelAtPeriodEnd: false, updatedAt: new Date() },
      $unset: { subscriptionExpiresAt: '' },
    }
  );
  const active = await services()
    .find({ vendorId, status: { $ne: 'Rejected' }, isAvailable: true })
    .sort({ createdAt: -1 })
    .project({ _id: 1 })
    .toArray();
  const extra = active.slice(FREE_PLAN_ACTIVE_LIMIT).map((s) => s._id);
  if (extra.length) {
    await services().updateMany({ _id: { $in: extra } }, { $set: { isAvailable: false, updatedAt: new Date() } });
  }
}

/** Lazily applies expiry; also run on a timer from index.ts. */
export async function expireLapsedSubscriptions(): Promise<number> {
  const lapsed = await users()
    .find({ subscriptionPlan: 'Premium', $or: [{ subscriptionExpiresAt: { $lte: new Date() } }, { subscriptionExpiresAt: null }] })
    .project({ _id: 1 })
    .toArray();
  for (const u of lapsed) await downgradeToFree(String(u._id));
  return lapsed.length;
}

export async function getVendorOrThrow(id: string): Promise<UserDoc> {
  const oid = toOid(id);
  const v = oid ? await users().findOne({ _id: oid }) : null;
  if (!v) throw new NotFoundError('Vendor not found.');
  return v;
}
