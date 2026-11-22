import { auth } from '../auth.js';
import { env } from '../config/env.js';
import { users } from '../db.js';

/**
 * Admin accounts are NEVER created through public registration (the sign-up hook forces customer/vendor).
 * The one admin is provisioned here from environment variables: create through Better Auth (so the password is
 * hashed with its scheme), then elevate the role directly in the database.
 */
export async function ensureAdmin(): Promise<void> {
  const email = env.ADMIN_EMAIL.trim().toLowerCase();
  if (!email || !env.ADMIN_PASSWORD) {
    console.warn('[seed] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin provisioning.');
    return;
  }
  let existing = await users().findOne({ email });
  if (!existing) {
    await auth.api.signUpEmail({ body: { name: env.ADMIN_NAME, email, password: env.ADMIN_PASSWORD } });
    existing = await users().findOne({ email });
  }
  if (existing && existing.role !== 'admin') {
    await users().updateOne(
      { _id: existing._id },
      { $set: { role: 'admin', businessName: null, subscriptionPlan: 'Free', isBlocked: false, emailVerified: true, updatedAt: new Date() } }
    );
    console.log(`[seed] Admin account ready: ${email}`);
  }
}
