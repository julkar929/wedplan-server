import type { Document } from 'mongodb';
import { services, toOid, users, bookings, type ServiceDoc, type UserDoc } from '../db.js';
import { escapeRegex } from '../lib/http.js';
import { ForbiddenError, NotFoundError } from '../lib/errors.js';
import { assertCanHaveAnotherActiveService } from './subscription.js';
import { isPremiumActive } from './subscription.js';
import type { Category, ServiceStatus } from '../types.js';

export function toServiceDTO(s: ServiceDoc, vendor?: Partial<UserDoc> | null) {
  return {
    id: String(s._id),
    vendorId: s.vendorId,
    serviceName: s.serviceName,
    category: s.category,
    description: s.description,
    price: s.price,
    location: s.location,
    images: s.images,
    status: s.status,
    isAvailable: s.isAvailable,
    createdAt: s.createdAt.toISOString(),
    vendor: vendor
      ? {
          id: String(vendor._id),
          name: vendor.name ?? '',
          businessName: vendor.businessName ?? null,
          image: vendor.image ?? null,
          location: vendor.location ?? null,
          phone: vendor.phone ?? null,
          bio: vendor.bio ?? null,
          subscriptionPlan: vendor.subscriptionPlan && isPremiumActive(vendor as UserDoc) ? 'Premium' : 'Free',
        }
      : null,
  };
}

const VENDOR_JOIN: Document[] = [
  { $addFields: { vendorOid: { $toObjectId: '$vendorId' } } },
  { $lookup: { from: 'users', localField: 'vendorOid', foreignField: '_id', as: 'vendor' } },
  { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
];

function searchStage(search?: string): Document | null {
  const terms = (search || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return null;
  // Advanced search: every term must appear in at least one of the searchable fields (AND of ORs)
  return {
    $match: {
      $and: terms.map((t) => {
        const rx = new RegExp(escapeRegex(t), 'i');
        return {
          $or: [
            { serviceName: rx },
            { description: rx },
            { category: rx },
            { location: rx },
            { 'vendor.businessName': rx },
            { 'vendor.name': rx },
          ],
        };
      }),
    },
  };
}

export interface PublicFilters {
  search?: string;
  category?: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: 'price_asc' | 'price_desc' | 'newest';
  page?: number;
  limit?: number;
}

export async function listPublic(f: PublicFilters) {
  const match: Document = { status: 'Approved', isAvailable: true };
  if (f.category && f.category !== 'All') match.category = f.category;
  if (f.location?.trim()) match.location = new RegExp(escapeRegex(f.location.trim()), 'i');
  if (f.minPrice !== undefined || f.maxPrice !== undefined) {
    match.price = {
      ...(f.minPrice !== undefined ? { $gte: f.minPrice } : {}),
      ...(f.maxPrice !== undefined ? { $lte: f.maxPrice } : {}),
    };
  }

  const limit = Math.min(Math.max(f.limit ?? 12, 1), 50);
  const page = Math.max(f.page ?? 1, 1);

  const sort: Document =
    f.sort === 'price_asc'
      ? { price: 1, createdAt: -1 }
      : f.sort === 'price_desc'
        ? { price: -1, createdAt: -1 }
        : f.sort === 'newest'
          ? { createdAt: -1 }
          : { premiumRank: 0, createdAt: -1 };

  const pipeline: Document[] = [
    { $match: match },
    ...VENDOR_JOIN,
    { $match: { 'vendor.isBlocked': { $ne: true } } },
    ...(searchStage(f.search) ? [searchStage(f.search)!] : []),
    {
      $addFields: {
        premiumRank: {
          $cond: [
            { $and: [{ $eq: ['$vendor.subscriptionPlan', 'Premium'] }, { $gt: ['$vendor.subscriptionExpiresAt', '$$NOW'] }] },
            0,
            1,
          ],
        },
      },
    },
    { $sort: f.sort ? sort : { premiumRank: 1, createdAt: -1 } },
    {
      $facet: {
        items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'n' }],
      },
    },
  ];

  const [res] = await services().aggregate(pipeline).toArray();
  const total: number = res?.total?.[0]?.n ?? 0;
  return {
    items: (res?.items ?? []).map((d: any) => toServiceDTO(d, d.vendor)),
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
  };
}

export async function getDetails(id: string, viewer: UserDoc): Promise<ReturnType<typeof toServiceDTO>> {
  const oid = toOid(id);
  if (!oid) throw new NotFoundError('The requested wedding service could not be found.');
  const svc = await services().findOne({ _id: oid });
  if (!svc) throw new NotFoundError('The requested wedding service could not be found.');
  const vendor = await users().findOne({ _id: toOid(svc.vendorId)! });
  const isOwner = String(viewer._id) === svc.vendorId;
  const isAdmin = viewer.role === 'admin';
  if (!isOwner && !isAdmin) {
    if (svc.status !== 'Approved' || !svc.isAvailable || vendor?.isBlocked) {
      throw new NotFoundError('This wedding service is not currently available.');
    }
  }
  return toServiceDTO(svc, vendor);
}

export async function listVendorServices(vendorId: string) {
  const items = await services().find({ vendorId }).sort({ createdAt: -1 }).toArray();
  return items.map((s) => toServiceDTO(s));
}

export async function createService(
  vendor: UserDoc,
  input: { serviceName: string; category: Category; description: string; price: number; location: string; images: string[] }
) {
  await assertCanHaveAnotherActiveService(vendor);
  const now = new Date();
  const doc: Omit<ServiceDoc, '_id'> = {
    vendorId: String(vendor._id),
    ...input,
    status: 'Pending', // always pending until an admin approves
    isAvailable: true,
    createdAt: now,
    updatedAt: now,
  };
  const r = await services().insertOne(doc as ServiceDoc);
  return toServiceDTO({ ...doc, _id: r.insertedId } as ServiceDoc);
}

export async function updateService(
  vendor: UserDoc,
  id: string,
  updates: Partial<{ serviceName: string; category: Category; description: string; price: number; location: string; images: string[]; isAvailable: boolean }>
) {
  const oid = toOid(id);
  const existing = oid ? await services().findOne({ _id: oid }) : null;
  if (!existing) throw new NotFoundError('Service not found.');
  if (existing.vendorId !== String(vendor._id)) throw new ForbiddenError('You can only update your own services.');

  if (updates.isAvailable === true && !existing.isAvailable && existing.status !== 'Rejected') {
    await assertCanHaveAnotherActiveService(vendor);
  }

  const contentKeys = ['serviceName', 'category', 'description', 'price', 'location'] as const;
  const contentChanged =
    contentKeys.some((k) => updates[k] !== undefined && updates[k] !== existing[k]) ||
    (updates.images !== undefined && JSON.stringify(updates.images) !== JSON.stringify(existing.images));

  const $set: Partial<ServiceDoc> = { ...updates, updatedAt: new Date() };
  // Editing published content sends it back for admin review
  if (existing.status === 'Approved' && contentChanged) $set.status = 'Pending';

  const updated = await services().findOneAndUpdate({ _id: existing._id }, { $set }, { returnDocument: 'after' });
  return toServiceDTO(updated!);
}

export async function deleteService(actor: UserDoc, id: string) {
  const oid = toOid(id);
  const existing = oid ? await services().findOne({ _id: oid }) : null;
  if (!existing) throw new NotFoundError('Service not found.');
  if (actor.role !== 'admin' && existing.vendorId !== String(actor._id)) {
    throw new ForbiddenError('You can only delete your own services.');
  }
  await services().deleteOne({ _id: existing._id });
  // Pending requests for a removed service can no longer be fulfilled
  await bookings().updateMany(
    { serviceId: id, status: 'Pending' },
    { $set: { status: 'Cancelled', updatedAt: new Date() } }
  );
}

export async function adminListServices(f: { search?: string; category?: string; status?: string }) {
  const match: Document = {};
  if (f.category && f.category !== 'All') match.category = f.category;
  if (f.status && f.status !== 'All') match.status = f.status;
  const pipeline: Document[] = [
    { $match: match },
    ...VENDOR_JOIN,
    ...(searchStage(f.search) ? [searchStage(f.search)!] : []),
    { $sort: { createdAt: -1 } },
  ];
  const rows = await services().aggregate(pipeline).toArray();
  return rows.map((d: any) => toServiceDTO(d, d.vendor));
}

export async function adminModerate(id: string, updates: { status?: ServiceStatus; isAvailable?: boolean }) {
  const oid = toOid(id);
  const existing = oid ? await services().findOne({ _id: oid }) : null;
  if (!existing) throw new NotFoundError('Service not found.');

  const reopens =
    (existing.status === 'Rejected' && updates.status && updates.status !== 'Rejected') ||
    (!existing.isAvailable && updates.isAvailable === true && existing.status !== 'Rejected');
  if (reopens) {
    const vendor = await users().findOne({ _id: toOid(existing.vendorId)! });
    if (vendor) await assertCanHaveAnotherActiveService(vendor);
  }
  const updated = await services().findOneAndUpdate(
    { _id: existing._id },
    { $set: { ...updates, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return toServiceDTO(updated!);
}
