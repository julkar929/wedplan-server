import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import { env } from './config/env.js';
import type { BookingStatus, Category, Plan, Role, ServiceStatus, TxStatus } from './types.js';

export const client = new MongoClient(env.MONGODB_URI);
export const db: Db = client.db();

/** Better Auth owns this collection (name set via usePlural). Extra fields are declared in auth.ts. */
export interface UserDoc {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role: Role;
  isBlocked: boolean;
  businessName?: string | null;
  phone?: string | null;
  bio?: string | null;
  location?: string | null;
  subscriptionPlan: Plan;
  subscriptionExpiresAt?: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  cancelAtPeriodEnd?: boolean;
  subscriptionStatus?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceDoc {
  _id: ObjectId;
  vendorId: string;
  serviceName: string;
  category: Category;
  description: string;
  price: number;
  location: string;
  images: string[];
  status: ServiceStatus;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingDoc {
  _id: ObjectId;
  serviceId: string;
  vendorId: string;
  customerId: string;
  eventDate: string; // YYYY-MM-DD
  eventLocation: string;
  message: string;
  status: BookingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionDoc {
  _id: ObjectId;
  vendorId: string;
  plan: Plan;
  amount: number;
  currency: string;
  stripeSessionId: string;
  stripeSubscriptionId?: string | null;
  status: TxStatus;
  createdAt: Date;
}

export const users = (): Collection<UserDoc> => db.collection<UserDoc>('users');
export const services = (): Collection<ServiceDoc> => db.collection<ServiceDoc>('services');
export const bookings = (): Collection<BookingDoc> => db.collection<BookingDoc>('bookings');
export const transactions = (): Collection<TransactionDoc> => db.collection<TransactionDoc>('transactions');

export function toOid(id: string): ObjectId | null {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

export async function ensureIndexes(): Promise<void> {
  await services().createIndexes([
    { key: { vendorId: 1, createdAt: -1 } },
    { key: { status: 1, isAvailable: 1, category: 1 } },
    { key: { price: 1 } },
  ]);
  await bookings().createIndexes([
    { key: { customerId: 1, createdAt: -1 } },
    { key: { vendorId: 1, createdAt: -1 } },
    {
      // Race-safe duplicate prevention: one ACTIVE request per customer + service + event date
      key: { serviceId: 1, customerId: 1, eventDate: 1 },
      unique: true,
      partialFilterExpression: { status: { $in: ['Pending', 'Accepted'] } },
      name: 'uniq_active_booking',
    },
  ]);
  await transactions().createIndexes([
    { key: { stripeSessionId: 1 }, unique: true },
    { key: { vendorId: 1, createdAt: -1 } },
  ]);
  await users().createIndexes([{ key: { role: 1 } }, { key: { stripeSubscriptionId: 1 }, sparse: true }]);
}
