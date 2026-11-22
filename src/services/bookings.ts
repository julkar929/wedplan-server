import type { Document } from 'mongodb';
import { bookings, services, toOid, users, type BookingDoc, type UserDoc } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { BookingStatus } from '../types.js';

const toUserBrief = (u: any) =>
  u ? { id: String(u._id), name: u.name, email: u.email, image: u.image ?? null, businessName: u.businessName ?? null, phone: u.phone ?? null } : null;

function toBookingDTO(b: any) {
  return {
    id: String(b._id),
    serviceId: b.serviceId,
    vendorId: b.vendorId,
    customerId: b.customerId,
    eventDate: b.eventDate,
    eventLocation: b.eventLocation,
    message: b.message,
    status: b.status as BookingStatus,
    createdAt: new Date(b.createdAt).toISOString(),
    service: b.service
      ? { id: String(b.service._id), serviceName: b.service.serviceName, category: b.service.category, image: b.service.images?.[0] ?? null, price: b.service.price }
      : null,
    vendor: toUserBrief(b.vendor),
    customer: toUserBrief(b.customer),
  };
}

const JOINS: Document[] = [
  { $addFields: { sOid: { $toObjectId: '$serviceId' }, vOid: { $toObjectId: '$vendorId' }, cOid: { $toObjectId: '$customerId' } } },
  { $lookup: { from: 'services', localField: 'sOid', foreignField: '_id', as: 'service' } },
  { $lookup: { from: 'users', localField: 'vOid', foreignField: '_id', as: 'vendor' } },
  { $lookup: { from: 'users', localField: 'cOid', foreignField: '_id', as: 'customer' } },
  { $unwind: { path: '$service', preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
  { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
  { $sort: { createdAt: -1 } },
];

export function assertValidFutureDate(eventDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new ValidationError('Please provide a valid event date (YYYY-MM-DD).');
  const d = new Date(`${eventDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== eventDate) {
    throw new ValidationError('Please provide a valid event date.');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (eventDate < today) throw new ValidationError('Event date must be today or in the future.');
}

export async function createBooking(
  customer: UserDoc,
  input: { serviceId: string; eventDate: string; eventLocation: string; message: string }
) {
  if (customer.role !== 'customer') throw new ForbiddenError('Only Customer accounts can submit booking requests.');
  const sOid = toOid(input.serviceId);
  const service = sOid ? await services().findOne({ _id: sOid }) : null;
  if (!service) throw new NotFoundError('The requested wedding service was not found.');
  if (service.vendorId === String(customer._id)) throw new ForbiddenError('You cannot book your own service.');
  const vendor = await users().findOne({ _id: toOid(service.vendorId)! });
  if (service.status !== 'Approved' || !service.isAvailable || vendor?.isBlocked) {
    throw new ValidationError('This service is not currently approved or available for booking.');
  }
  assertValidFutureDate(input.eventDate);

  const now = new Date();
  const doc: Omit<BookingDoc, '_id'> = {
    serviceId: String(service._id),
    vendorId: service.vendorId,
    customerId: String(customer._id),
    eventDate: input.eventDate,
    eventLocation: input.eventLocation,
    message: input.message,
    status: 'Pending',
    createdAt: now,
    updatedAt: now,
  };
  try {
    const r = await bookings().insertOne(doc as BookingDoc);
    return toBookingDTO({ ...doc, _id: r.insertedId });
  } catch (e: any) {
    if (e?.code === 11000) {
      throw new ConflictError('You already have an active booking request for this service on the selected event date.');
    }
    throw e;
  }
}

export async function listForCustomer(customerId: string) {
  const rows = await bookings().aggregate([{ $match: { customerId } }, ...JOINS]).toArray();
  return rows.map(toBookingDTO);
}

export async function listForVendor(vendorId: string) {
  const rows = await bookings().aggregate([{ $match: { vendorId } }, ...JOINS]).toArray();
  return rows.map(toBookingDTO);
}

export async function respond(vendor: UserDoc, id: string, decision: 'Accepted' | 'Rejected') {
  const oid = toOid(id);
  const booking = oid ? await bookings().findOne({ _id: oid }) : null;
  if (!booking) throw new NotFoundError('Booking request not found.');
  if (booking.vendorId !== String(vendor._id)) throw new ForbiddenError('You are not authorized to manage bookings for another vendor.');
  // Atomic transition: only a still-Pending request can move (no double processing under races)
  const r = await bookings().findOneAndUpdate(
    { _id: booking._id, status: 'Pending' },
    { $set: { status: decision, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!r) throw new ConflictError(`Cannot update a booking that is already ${booking.status}.`);
  return toBookingDTO(r);
}

export async function cancel(customer: UserDoc, id: string) {
  const oid = toOid(id);
  const booking = oid ? await bookings().findOne({ _id: oid }) : null;
  if (!booking) throw new NotFoundError('Booking request not found.');
  if (booking.customerId !== String(customer._id)) throw new ForbiddenError('You cannot cancel another customer’s booking request.');
  const r = await bookings().findOneAndUpdate(
    { _id: booking._id, status: 'Pending' },
    { $set: { status: 'Cancelled', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!r) throw new ConflictError(`Only Pending booking requests can be cancelled (current: ${booking.status}).`);
  return toBookingDTO(r);
}

export async function customerOverview(customerId: string) {
  const c = (s: string) => bookings().countDocuments({ customerId, status: s as BookingStatus });
  const [total, pending, accepted, rejected] = await Promise.all([
    bookings().countDocuments({ customerId }),
    c('Pending'),
    c('Accepted'),
    c('Rejected'),
  ]);
  return { totalBookings: total, pendingBookings: pending, acceptedBookings: accepted, rejectedBookings: rejected };
}
