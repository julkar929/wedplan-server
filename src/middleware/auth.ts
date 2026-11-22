import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth.js';
import { toOid, users } from '../db.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import type { Role } from '../types.js';

/**
 * JWT verification middleware.
 * - Token is a Better Auth JWT (jwt plugin), sent as `Authorization: Bearer <token>`.
 * - Signature, issuer and expiry are verified against the server's JWKS.
 * - The token's claims are NEVER trusted for authorisation: the user is re-loaded from MongoDB on every
 *   request so role changes and blocking take effect immediately.
 * Missing / invalid / expired token -> 401.  Blocked account -> 403.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication token is missing.');
    }
    const token = header.slice(7).trim();

    let sub: string | undefined;
    try {
      const result = await auth.api.verifyJWT({ body: { token } });
      sub = result?.payload?.sub;
    } catch {
      sub = undefined;
    }
    if (!sub) throw new UnauthorizedError('Your session has expired or is invalid. Please sign in again.');

    const oid = toOid(sub);
    const user = oid ? await users().findOne({ _id: oid }) : null;
    if (!user) throw new UnauthorizedError('Account no longer exists.');
    if (user.isBlocked) throw new ForbiddenError('Your account has been blocked by an administrator.');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole =
  (...allowed: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (!allowed.includes(req.user.role)) {
      return next(new ForbiddenError(`Access denied. Required role: ${allowed.join(' or ')}.`));
    }
    next();
  };
