import { bookings, services, toOid, transactions, users, type TransactionDoc, type UserDoc } from '../db.js';
import { toUserDTO, escapeRegex } from '../lib/http.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';

export async function overview() {
  const [totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions, rev] = await Promise.all([
    users().countDocuments({}),
    users().countDocuments({ role: 'vendor' }),
    users().countDocuments({ role: 'customer' }),
    services().countDocuments({}),
    services().countDocuments({ status: 'Pending' }),
    transactions().countDocuments({}),
    transactions().aggregate([{ $match: { status: 'Succeeded' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
  ]);
  return { totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions, totalRevenue: rev[0]?.total ?? 0 };
}

export async function listUsers(f: { search?: string; role?: string }) {
  const q: Record<string, unknown> = {};
  if (f.role && f.role !== 'All') q.role = f.role;
  if (f.search?.trim()) {
    const rx = new RegExp(escapeRegex(f.search.trim()), 'i');
    q.$or = [{ name: rx }, { email: rx }, { businessName: rx }];
  }
  const rows = await users().find(q).sort({ createdAt: -1 }).limit(500).toArray();
  return rows.map(toUserDTO);
}

export async function userDetails(id: string) {
  const oid = toOid(id);
  const u = oid ? await users().findOne({ _id: oid }) : null;
  if (!u) throw new NotFoundError('User not found.');
  const sid = String(u._id);
  const [serviceCount, bookingCount] = await Promise.all([
    services().countDocuments({ vendorId: sid }),
    bookings().countDocuments(u.role === 'vendor' ? { vendorId: sid } : { customerId: sid }),
  ]);
  return { user: toUserDTO(u), stats: { services: serviceCount, bookings: bookingCount } };
}

export async function setBlocked(admin: UserDoc, targetId: string, isBlocked: boolean) {
  if (String(admin._id) === targetId) throw new ForbiddenError('Administrators cannot block their own account.');
  const oid = toOid(targetId);
  const target = oid ? await users().findOne({ _id: oid }) : null;
  if (!target) throw new NotFoundError('User not found.');
  if (target.role === 'admin') throw new ForbiddenError('Administrator accounts cannot be blocked.');
  const r = await users().findOneAndUpdate({ _id: target._id }, { $set: { isBlocked, updatedAt: new Date() } }, { returnDocument: 'after' });
  if (isBlocked) {
    // Revoke active sessions so a blocked user is signed out everywhere
    await users().db.collection('sessions').deleteMany({ userId: target._id }).catch(() => undefined);
    await users().db.collection('sessions').deleteMany({ userId: String(target._id) }).catch(() => undefined);
  }
  return toUserDTO(r!);
}

/** Read-only: there is intentionally NO function that edits a transaction's status. */
export async function listTransactions() {
  const rows = await transactions().aggregate([
    { $addFields: { vOid: { $toObjectId: '$vendorId' } } },
    { $lookup: { from: 'users', localField: 'vOid', foreignField: '_id', as: 'vendor' } },
    { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
  ]).toArray();
  return rows.map((t: any) => toTransactionDTO(t, t.vendor));
}

export function toTransactionDTO(t: TransactionDoc, vendor?: any) {
  return {
    id: String(t._id),
    vendorId: t.vendorId,
    plan: t.plan,
    amount: t.amount,
    currency: t.currency,
    stripeSessionId: t.stripeSessionId,
    stripeSubscriptionId: t.stripeSubscriptionId ?? null,
    status: t.status,
    createdAt: new Date(t.createdAt).toISOString(),
    vendor: vendor ? { id: String(vendor._id), name: vendor.name, email: vendor.email, businessName: vendor.businessName ?? null } : null,
  };
}
