import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { jwt } from 'better-auth/plugins';
import { APIError, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { ObjectId } from 'mongodb';
import { env } from './config/env.js';
import { client, db } from './db.js';

/** Fields a user must never be able to change through Better Auth's own update endpoints. */
const PROTECTED_FIELDS = [
  'role',
  'isBlocked',
  'subscriptionPlan',
  'subscriptionExpiresAt',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'cancelAtPeriodEnd',
  'subscriptionStatus',
  'email',
  'emailVerified',
];

export function assertPasswordPolicy(password: unknown): void {
  if (typeof password !== 'string' || password.length < 6) {
    throw new APIError('BAD_REQUEST', { message: 'Password must be at least 6 characters long.' });
  }
  if (!/[A-Z]/.test(password)) {
    throw new APIError('BAD_REQUEST', { message: 'Password must include at least one uppercase letter.' });
  }
  if (!/[a-z]/.test(password)) {
    throw new APIError('BAD_REQUEST', { message: 'Password must include at least one lowercase letter.' });
  }
}

export const auth = betterAuth({
  appName: 'WedPlan',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.CLIENT_URL, env.SERVER_URL],
  database: mongodbAdapter(db, { client, usePlural: true, transaction: false }),

  emailAndPassword: { enabled: true, minPasswordLength: 6, autoSignIn: true },

  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account' as const,
          },
        }
      : {},

  user: {
    additionalFields: {
      // Chosen at sign-up only. Sanitised in the create hook; can never be changed afterwards.
      role: { type: 'string', required: false, defaultValue: 'customer', input: true },
      isBlocked: { type: 'boolean', required: false, defaultValue: false, input: false },
      businessName: { type: 'string', required: false, input: true },
      phone: { type: 'string', required: false, input: true },
      bio: { type: 'string', required: false, input: true },
      location: { type: 'string', required: false, input: true },
      subscriptionPlan: { type: 'string', required: false, defaultValue: 'Free', input: false },
      subscriptionExpiresAt: { type: 'date', required: false, input: false },
      stripeCustomerId: { type: 'string', required: false, input: false, returned: false },
      stripeSubscriptionId: { type: 'string', required: false, input: false, returned: false },
      cancelAtPeriodEnd: { type: 'boolean', required: false, defaultValue: false, input: false },
      subscriptionStatus: { type: 'string', required: false, input: false, returned: false },
    },
  },

  advanced: {
    cookiePrefix: 'wedplan',
    useSecureCookies: env.isProduction,
    // Never let the environment (e.g. NODE_ENV=test) switch off CSRF/origin validation.
    disableOriginCheck: false,
    disableCSRFCheck: false,
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Role: email sign-up sends it in the body; Google sign-up sends it via OAuth state.
          let requested: unknown = (user as Record<string, unknown>).role;
          if (!requested) {
            const state = await getOAuthState().catch(() => null);
            requested = state?.role;
          }
          // Admin can NEVER be created through public registration.
          const role = requested === 'vendor' ? 'vendor' : 'customer';
          const name = String(user.name || '').trim();
          return {
            data: {
              ...user,
              name,
              role,
              isBlocked: false,
              subscriptionPlan: 'Free',
              subscriptionExpiresAt: null,
              businessName:
                role === 'vendor'
                  ? String((user as Record<string, unknown>).businessName || '').trim() || `${name} Studio`
                  : null,
            },
          };
        },
      },
      update: {
        before: async (data) => {
          // Defence in depth: even if a field slips past `input: false`, strip it here.
          const clean: Record<string, unknown> = { ...data };
          for (const f of PROTECTED_FIELDS) delete clean[f];
          return { data: clean };
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (!ObjectId.isValid(session.userId)) return;
          const u = await db.collection('users').findOne({ _id: new ObjectId(session.userId) });
          if (u?.isBlocked) {
            throw new APIError('FORBIDDEN', {
              message: 'Your account has been blocked by an administrator.',
            });
          }
        },
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        assertPasswordPolicy(ctx.body?.password);
      }
      if (ctx.path === '/reset-password' || ctx.path === '/change-password') {
        assertPasswordPolicy(ctx.body?.newPassword);
      }
      if (ctx.path === '/update-user') {
        for (const f of PROTECTED_FIELDS) {
          if (ctx.body && f in ctx.body) {
            throw new APIError('FORBIDDEN', { message: `You are not allowed to change "${f}".` });
          }
        }
      }
    }),
  },

  plugins: [
    jwt({
      jwt: {
        expirationTime: '15m',
        definePayload: ({ user }) => ({ role: (user as { role?: string }).role }),
      },
    }),
  ],
});

export type Auth = typeof auth;
