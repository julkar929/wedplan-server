# WedPlan Server (API)

Express + MongoDB backend for **WedPlan – Wedding Planning Platform**. Authentication is handled by **Better Auth**
(email/password + Google OAuth) and every protected API call is authorised with a **Better Auth JWT** verified by
Express middleware. Premium vendor subscriptions use **Stripe Checkout (test mode)** and are activated **only** by
signature-verified webhooks. Images are hosted on **ImgBB**.

- **Client repo:** <https://github.com/julkar929/wedplan-client>
- **Live API:** _add deployed URL_
- **Live client:** _add deployed URL_

## Architecture

```
Browser ──(same-origin)──▶ Next.js client ──rewrite /api/*──▶ Express API ──▶ MongoDB
                                │                                   ▲
                       Better Auth session cookie                   │ Stripe ──webhook──▶ /api/webhooks/stripe
                       + short-lived JWT (Authorization: Bearer)     │ ImgBB  ◀──upload──── /api/upload
```

1. The client signs the user in through Better Auth (`/api/auth/*`, mounted in this server and reached through the client’s
   rewrite proxy, so there are no CORS or third-party-cookie problems).
2. The client asks Better Auth for a JWT (`GET /api/auth/token`, authenticated by the session cookie) and sends it as
   `Authorization: Bearer <jwt>` to the REST API. Tokens live 15 minutes and are kept **in memory only** (never localStorage).
3. `requireAuth` verifies the JWT signature/issuer/expiry against the server’s JWKS **and re-loads the user from MongoDB**
   on every request, so role changes and blocking take effect immediately. `requireRole(...)` enforces RBAC.
   Missing/invalid/expired token → **401**; wrong role or blocked account → **403**.

### Security rules implemented (all covered by tests)
| Rule | Where |
|---|---|
| Admin can never be created by public sign-up (role is sanitised to `customer`/`vendor`) | `auth.ts` user create hook |
| Users cannot change `role`, plan, block flag, e-mail via Better Auth or `/api/profile` | `auth.ts` hooks, strict zod schema |
| Blocked users cannot sign in and existing tokens stop working instantly; sessions are revoked | `auth.ts`, `middleware/auth.ts`, `services/admin.ts` |
| Password policy: ≥ 6 chars, upper + lower case | `auth.ts` before-hook |
| CSRF / origin validation always on | `auth.ts` (`disableOriginCheck: false`) |
| Premium is granted only by a signature-verified Stripe webhook (never by a redirect/URL) | `routes`, `services/stripeEvents.ts` |
| Checkout always bound to the authenticated vendor, never a client-sent id | `services/payments.ts` |
| Admin has **no** endpoint that can edit a transaction | `routes/index.ts` |
| Free vendors: max 3 active services (create, re-enable **and** admin re-approval) | `services/subscription.ts` |
| Editing an approved service returns it to Pending review | `services/catalog.ts` |
| Duplicate booking requests are impossible even under race conditions (partial unique index) | `db.ts`, `services/bookings.ts` |
| Image upload requires login, real PNG/JPEG/WEBP magic bytes, ≤ 5 MB; ImgBB key stays server-side | `services/images.ts` |
| Helmet headers, rate limiting on auth, JSON error handler, secrets from env only | `app.ts`, `config/env.ts` |

## Setup

```bash
npm install
cp .env.example .env      # fill in the values (see below)
npm run seed              # optional demo data
npm run dev               # http://localhost:5000
```

### Environment variables (`.env.example`)
| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | ✅ | e.g. MongoDB Atlas connection string including the database name |
| `BETTER_AUTH_SECRET` | ✅ | ≥ 32 chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BETTER_AUTH_URL` / `CLIENT_URL` | ✅ | The **client** URL (e.g. `http://localhost:3000`) |
| `SERVER_URL` | ✅ | This API’s public URL |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | ✅ | Seeded admin account (created at start-up if missing) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google login | Redirect URI: `{CLIENT_URL}/api/auth/callback/google` |
| `STRIPE_SECRET_KEY` | for payments | Test-mode key `sk_test_…`. Required in production |
| `STRIPE_WEBHOOK_SECRET` | for payments | `whsec_…`. Required in production |
| `STRIPE_PREMIUM_PRICE_ID` | optional | Existing recurring price; otherwise `$PREMIUM_PRICE_USD`/month is created inline |
| `IMGBB_API_KEY` | production | In development without a key, uploads fall back to local disk |

The server **refuses to start** with missing/short secrets, and in production without Stripe/ImgBB keys.

### Stripe (test mode)
1. Dashboard → Developers → API keys → copy `sk_test_…` into `STRIPE_SECRET_KEY`.
2. Local webhook: `stripe listen --forward-to localhost:5000/api/webhooks/stripe` → copy the printed `whsec_…`.
   Production: add endpoint `{SERVER_URL}/api/webhooks/stripe` with events
   `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
3. Test card: `4242 4242 4242 4242`, any future date, any CVC. Failure card: `4000 0000 0000 0002`.

Subscription lifecycle: _checkout completed_ → Premium (provisional 35 days) → _invoice.paid_ sets the exact period end and
records renewals → _payment failed_ is recorded → _cancel_ (button in the vendor dashboard) keeps access until the period ends →
_subscription deleted/expired_ downgrades to Free and pauses services beyond the newest three.

## API overview
| Area | Endpoints |
|---|---|
| Auth (Better Auth) | `POST /api/auth/sign-up/email`, `/sign-in/email`, `/sign-in/social`, `/sign-out`, `GET /api/auth/get-session`, `GET /api/auth/token` (JWT) |
| Public | `GET /api/services?search&category&location&minPrice&maxPrice&sort&page&limit` |
| Any signed-in user | `GET /api/me`, `PUT /api/profile`, `POST /api/upload`, `GET /api/services/:id` |
| Customer | `GET /api/customer/overview`, `GET/POST /api/customer/bookings`, `PATCH /api/customer/bookings/:id/cancel` |
| Vendor | `GET /api/vendor/overview`, `GET/POST /api/vendor/services`, `PUT/DELETE /api/vendor/services/:id`, `GET /api/vendor/bookings`, `PATCH /api/vendor/bookings/:id`, `POST /api/vendor/subscription/checkout`, `GET …/session/:id`, `POST …/cancel`, `GET /api/vendor/transactions` |
| Admin | `GET /api/admin/overview`, `/users`, `/users/:id`, `PATCH /users/:id/block`, `/services`, `PATCH/DELETE /services/:id`, `GET /transactions` |
| Webhook | `POST /api/webhooks/stripe` (raw body, signature verified) |

## Tests
```bash
npm test          # starts a throw-away mongod (needs `mongod` on PATH) and runs 43 API tests
npm run test:run  # if MongoDB is already running at TEST_MONGO (default mongodb://127.0.0.1:27099)
```
The suite exercises the real stack (MongoDB + Better Auth + JWT middleware + signed Stripe webhooks): RBAC, token tampering,
privilege-escalation attempts, Free-plan limits, booking races, webhook signature forgery, subscription lifecycle, blocking,
uploads and error handling. Stripe *Checkout session creation* is stubbed (no network); everything else is real.

## Deployment
Any Node host works (Render, Railway, Fly.io, a VPS). Set all env vars, start command `npm start`, then point
`/api/webhooks/stripe` at it. Use MongoDB Atlas for the database. Note that the server is a long-running Express app, so it is
not suited to Vercel serverless functions; deploy the **client** on Vercel and the **server** on Render/Railway.
