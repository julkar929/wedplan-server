import express, { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { env } from '../config/env.js';
import { users } from '../db.js';
import { str, toUserDTO, wrap } from '../lib/http.js';
import { ForbiddenError, ValidationError } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as admin from '../services/admin.js';
import * as bookingSvc from '../services/bookings.js';
import * as catalog from '../services/catalog.js';
import { UPLOAD_DIR, uploadImage } from '../services/images.js';
import * as payments from '../services/payments.js';
import { expireLapsedSubscriptions, isPremiumActive } from '../services/subscription.js';
import { BOOKING_STATUSES, CATEGORIES, FREE_PLAN_ACTIVE_LIMIT, SERVICE_STATUSES, type Category } from '../types.js';
import { services as servicesCol, bookings as bookingsCol, type UserDoc } from '../db.js';

const category = z.enum(CATEGORIES as unknown as [Category, ...Category[]]);

const serviceInput = z.object({
  serviceName: z.string().trim().min(3, 'Service name must be at least 3 characters.').max(120),
  category,
  description: z.string().trim().min(20, 'Please provide a descriptive overview (min 20 characters).').max(4000),
  price: z.coerce.number({ invalid_type_error: 'Price must be a number.' } as never).positive('Price must be greater than zero.').max(100_000_000),
  location: z.string().trim().min(2, 'Location is required.').max(120),
  images: z.array(z.string().min(1).max(2000)).min(1, 'At least one service image is required.').max(8),
});

const httpUrlOrUpload = (v: string) => /^https?:\/\//i.test(v) || v.startsWith('/api/uploads/');

export function createApiRouter(): Router {
  const r = Router();

  r.get('/health', (_req, res) => res.json({ status: 'ok' }));
  r.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false }));

  // ---------------- Current user & profile ----------------
  r.get('/me', requireAuth, wrap((req, res) => res.json({ user: toUserDTO(req.user!) })));

  r.put('/profile', requireAuth, wrap(async (req, res) => {
    const data = z.object({
      name: z.string().trim().min(2, 'Full name must be at least 2 characters.').max(80).optional(),
      image: z.string().max(2000).nullable().optional().refine((v) => v == null || v === '' || httpUrlOrUpload(v), 'Invalid image URL.'),
      businessName: z.string().trim().max(120).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      bio: z.string().trim().max(600, 'Bio must be 600 characters or fewer.').nullable().optional(),
      location: z.string().trim().max(120).nullable().optional(),
    }).strict().parse(req.body); // .strict(): unknown keys (role, subscriptionPlan...) are rejected outright
    const user = req.user!;
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'businessName' && user.role !== 'vendor') continue;
      $set[k] = v === '' ? null : v;
    }
    const updated = await users().findOneAndUpdate({ _id: user._id }, { $set }, { returnDocument: 'after' });
    res.json({ user: toUserDTO(updated!) });
  }));

  r.post('/upload', requireAuth, wrap(async (req, res) => {
    const data = z.object({ imageBase64: z.string().min(20, 'Image file data is required.'), fileName: z.string().max(120).optional() }).parse(req.body);
    res.json(await uploadImage(data.imageBase64, data.fileName));
  }));

  // ---------------- Public catalog ----------------
  r.get('/services', wrap(async (req, res) => {
    const q = req.query;
    const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const sort = q.sort === 'price_asc' || q.sort === 'price_desc' || q.sort === 'newest' ? q.sort : undefined;
    res.json(await catalog.listPublic({
      search: str(q.search), category: str(q.category), location: str(q.location),
      minPrice: num(q.minPrice), maxPrice: num(q.maxPrice), sort, page: num(q.page), limit: num(q.limit),
    }));
  }));

  r.get('/services/:id', requireAuth, wrap(async (req, res) => {
    res.json({ service: await catalog.getDetails(req.params.id, req.user!) });
  }));

  // ---------------- Customer ----------------
  const customer = Router();
  customer.use(requireAuth, requireRole('customer'));
  customer.get('/overview', wrap(async (req, res) => res.json(await bookingSvc.customerOverview(String(req.user!._id)))));
  customer.get('/bookings', wrap(async (req, res) => res.json({ items: await bookingSvc.listForCustomer(String(req.user!._id)) })));
  customer.post('/bookings', wrap(async (req, res) => {
    const data = z.object({
      serviceId: z.string().min(1, 'Service ID is required.'),
      eventDate: z.string().min(8, 'Event date is required.'),
      eventLocation: z.string().trim().min(3, 'Event location is required.').max(200),
      message: z.string().trim().min(5, 'Please include a brief message about your wedding.').max(2000),
    }).parse(req.body);
    res.status(201).json({ booking: await bookingSvc.createBooking(req.user!, data) });
  }));
  customer.patch('/bookings/:id/cancel', wrap(async (req, res) => res.json({ booking: await bookingSvc.cancel(req.user!, req.params.id) })));
  r.use('/customer', customer);

  // ---------------- Vendor ----------------
  const vendor = Router();
  vendor.use(requireAuth, requireRole('vendor'));
  vendor.get('/overview', wrap(async (req, res) => {
    let v: UserDoc = req.user!;
    if (v.subscriptionPlan === 'Premium' && !isPremiumActive(v)) {
      await expireLapsedSubscriptions();
      v = (await users().findOne({ _id: v._id }))!;
    }
    const id = String(v._id);
    const [totalServices, activeServices, pendingBookings, acceptedBookings] = await Promise.all([
      servicesCol().countDocuments({ vendorId: id }),
      servicesCol().countDocuments({ vendorId: id, status: 'Approved', isAvailable: true }),
      bookingsCol().countDocuments({ vendorId: id, status: 'Pending' }),
      bookingsCol().countDocuments({ vendorId: id, status: 'Accepted' }),
    ]);
    res.json({
      totalServices, activeServices, pendingBookings, acceptedBookings,
      subscriptionPlan: isPremiumActive(v) ? 'Premium' : 'Free',
      subscriptionExpiresAt: isPremiumActive(v) ? new Date(v.subscriptionExpiresAt!).toISOString() : null,
      cancelAtPeriodEnd: !!v.cancelAtPeriodEnd,
      freeTierLimit: FREE_PLAN_ACTIVE_LIMIT,
    });
  }));
  vendor.get('/services', wrap(async (req, res) => res.json({ items: await catalog.listVendorServices(String(req.user!._id)) })));
  vendor.post('/services', wrap(async (req, res) => {
    const data = serviceInput.parse(req.body);
    if (!data.images.every(httpUrlOrUpload)) throw new ValidationError('Images must be hosted image URLs.');
    res.status(201).json({ service: await catalog.createService(req.user!, data) });
  }));
  vendor.put('/services/:id', wrap(async (req, res) => {
    const data = serviceInput.partial().extend({ isAvailable: z.boolean().optional() }).strict().parse(req.body);
    if (data.images && !data.images.every(httpUrlOrUpload)) throw new ValidationError('Images must be hosted image URLs.');
    res.json({ service: await catalog.updateService(req.user!, req.params.id, data) });
  }));
  vendor.delete('/services/:id', wrap(async (req, res) => { await catalog.deleteService(req.user!, req.params.id); res.json({ success: true }); }));
  vendor.get('/bookings', wrap(async (req, res) => res.json({ items: await bookingSvc.listForVendor(String(req.user!._id)) })));
  vendor.patch('/bookings/:id', wrap(async (req, res) => {
    const { status } = z.object({ status: z.enum(['Accepted', 'Rejected']) }).parse(req.body);
    res.json({ booking: await bookingSvc.respond(req.user!, req.params.id, status) });
  }));
  vendor.post('/subscription/checkout', wrap(async (req, res) => res.json(await payments.startPremiumCheckout(req.user!))));
  vendor.get('/subscription/session/:sessionId', wrap(async (req, res) => res.json(await payments.sessionStatus(req.user!, req.params.sessionId))));
  vendor.post('/subscription/cancel', wrap(async (req, res) => res.json(await payments.cancelSubscription(req.user!))));
  vendor.get('/transactions', wrap(async (req, res) => res.json({ items: await payments.listVendorTransactions(String(req.user!._id)) })));
  r.use('/vendor', vendor);

  // ---------------- Admin ----------------
  const adminR = Router();
  adminR.use(requireAuth, requireRole('admin'));
  adminR.get('/overview', wrap(async (_req, res) => res.json(await admin.overview())));
  adminR.get('/users', wrap(async (req, res) => res.json({ items: await admin.listUsers({ search: str(req.query.search), role: str(req.query.role) }) })));
  adminR.get('/users/:id', wrap(async (req, res) => res.json(await admin.userDetails(req.params.id))));
  adminR.patch('/users/:id/block', wrap(async (req, res) => {
    const { isBlocked } = z.object({ isBlocked: z.boolean() }).parse(req.body);
    res.json({ user: await admin.setBlocked(req.user!, req.params.id, isBlocked) });
  }));
  adminR.get('/services', wrap(async (req, res) => res.json({ items: await catalog.adminListServices({ search: str(req.query.search), category: str(req.query.category), status: str(req.query.status) }) })));
  adminR.patch('/services/:id', wrap(async (req, res) => {
    const data = z.object({ status: z.enum(SERVICE_STATUSES).optional(), isAvailable: z.boolean().optional() }).strict().parse(req.body);
    res.json({ service: await catalog.adminModerate(req.params.id, data) });
  }));
  adminR.delete('/services/:id', wrap(async (req, res) => { await catalog.deleteService(req.user!, req.params.id); res.json({ success: true }); }));
  adminR.get('/transactions', wrap(async (_req, res) => res.json({ items: await admin.listTransactions() })));
  // NOTE: no PUT/PATCH/POST on transactions exists for admins by design.
  r.use('/admin', adminR);

  void BOOKING_STATUSES; void ForbiddenError; void fs; void env;
  return r;
}
