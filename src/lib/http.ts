import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserDoc } from '../db.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
    }
  }
}

/** Forwards async errors to Express (Express 4 does not do this itself). */
export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function toUserDTO(u: UserDoc) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    image: u.image ?? null,
    role: u.role,
    isBlocked: !!u.isBlocked,
    businessName: u.businessName ?? null,
    phone: u.phone ?? null,
    bio: u.bio ?? null,
    location: u.location ?? null,
    subscriptionPlan: u.subscriptionPlan ?? 'Free',
    subscriptionExpiresAt: u.subscriptionExpiresAt ? new Date(u.subscriptionExpiresAt).toISOString() : null,
    cancelAtPeriodEnd: !!u.cancelAtPeriodEnd,
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
  };
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
