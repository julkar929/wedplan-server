import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

// ---- environment must be set BEFORE the app modules are imported ----
const DB = `wedplan_test_${Date.now()}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  CLIENT_URL: 'http://localhost:3000',
  SERVER_URL: 'http://localhost:5099',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'unit-test-secret-unit-test-secret-1234567890',
  MONGODB_URI: `${process.env.TEST_MONGO || 'mongodb://127.0.0.1:27099'}/${DB}`,
  STRIPE_WEBHOOK_SECRET: 'whsec_unit_test_secret',
  ADMIN_EMAIL: 'admin@wedplan.com',
  ADMIN_PASSWORD: 'Adm1nStrongPass',
  STRIPE_SECRET_KEY: '',
  IMGBB_API_KEY: '',
});

const ORIGIN = 'http://localhost:3000';
let base = '';
let server: Server;
let stripeHolder: any;
let db: any;
let StripeLib: any;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, headers: res.headers };
}

async function register(name: string, email: string, role: 'customer' | 'vendor', password = 'Abcdef1') {
  return call('POST', '/api/auth/sign-up/email', { body: { name, email, password, role } });
}

/** Real flow: email sign-in -> session cookie -> GET /api/auth/token -> Bearer JWT */
async function login(email: string, password = 'Abcdef1') {
  const res = await call('POST', '/api/auth/sign-in/email', { body: { email, password } });
  if (res.status !== 200) return { token: '', res };
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const t = await fetch(base + '/api/auth/token', { headers: { cookie, origin: ORIGIN } });
  const { token } = (await t.json()) as { token: string };
  return { token, res };
}

const futureDate = (days = 30) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const svcBody = (n: string, extra: object = {}) => ({
  serviceName: `Service ${n}`, category: 'Catering Services', description: 'A long enough description for validation.',
  price: 1000, location: 'Dhaka', images: ['https://picsum.photos/seed/a/400/300'], ...extra,
});

const T: Record<string, string> = {};
const ids: Record<string, string> = {};

describe('WedPlan API (real MongoDB + Better Auth)', () => {
  before(async () => {
    const mod = await import('../src/db.js');
    db = mod;
    await mod.client.connect();
    await mod.ensureIndexes();
    const { ensureAdmin } = await import('../src/services/seedAdmin.js');
    await ensureAdmin();
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    stripeHolder = (await import('../src/lib/stripe.js')).stripeHolder;
    StripeLib = (await import('stripe')).default;
  });

  after(async () => {
    server?.close();
    await db.db.dropDatabase();
    await db.client.close();
  });

  describe('Authentication & role safety', () => {
    it('forces role to customer when someone tries to self-register as admin', async () => {
      const r = await register('Evil Admin', 'evil@x.com', 'admin' as any);
      assert.equal(r.status, 200);
      assert.equal(r.json.user.role, 'customer');
    });
    it('rejects weak passwords (no uppercase / too short)', async () => {
      assert.equal((await register('Weak One', 'weak1@x.com', 'customer', 'abcdef')).status, 400);
      assert.equal((await register('Weak Two', 'weak2@x.com', 'customer', 'Ab1')).status, 400);
    });
    it('rejects duplicate emails', async () => {
      await register('Dup', 'dup@x.com', 'customer');
      assert.notEqual((await register('Dup', 'dup@x.com', 'customer')).status, 200);
    });
    it('creates vendor and customer accounts with the right defaults', async () => {
      const v = await register('Vendor One', 'v1@x.com', 'vendor');
      assert.equal(v.json.user.role, 'vendor');
      assert.equal(v.json.user.subscriptionPlan, 'Free');
      assert.equal(v.json.user.businessName, 'Vendor One Studio');
      await register('Vendor Two', 'v2@x.com', 'vendor');
      await register('Cust One', 'c1@x.com', 'customer');
      await register('Cust Two', 'c2@x.com', 'customer');
      for (const [k, e, p] of [['v1','v1@x.com','Abcdef1'],['v2','v2@x.com','Abcdef1'],['c1','c1@x.com','Abcdef1'],['c2','c2@x.com','Abcdef1'],['admin','admin@wedplan.com','Adm1nStrongPass']]) {
        const { token } = await login(e, p);
        assert.ok(token, `token for ${k}`);
        T[k] = token;
      }
      ids.v1 = (await call('GET', '/api/me', { token: T.v1 })).json.user.id;
      ids.c1 = (await call('GET', '/api/me', { token: T.c1 })).json.user.id;
      ids.c2 = (await call('GET', '/api/me', { token: T.c2 })).json.user.id;
      ids.v2 = (await call('GET', '/api/me', { token: T.v2 })).json.user.id;
    });
    it('seeded admin has the admin role', async () => {
      assert.equal((await call('GET', '/api/me', { token: T.admin })).json.user.role, 'admin');
    });
    it('wrong password is rejected', async () => {
      assert.equal((await login('c1@x.com', 'Wrongpass1')).res.status, 401);
    });
    it('Better Auth rejects cross-origin requests that carry a session cookie (CSRF)', async () => {
      const l = await call('POST', '/api/auth/sign-in/email', { body: { email: 'c1@x.com', password: 'Abcdef1' } });
      const cookie = l.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const r = await fetch(base + '/api/auth/update-user', { method: 'POST', headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hijacked' }) });
      assert.equal(r.status, 403);
    });
  });

  describe('JWT middleware & RBAC', () => {
    it('401 without token / garbage token / tampered token', async () => {
      assert.equal((await call('GET', '/api/admin/overview')).status, 401);
      assert.equal((await call('GET', '/api/admin/overview', { token: 'a.b.c' })).status, 401);
      const tampered = T.admin.slice(0, -3) + (T.admin.endsWith('AAA') ? 'BBB' : 'AAA');
      assert.equal((await call('GET', '/api/admin/overview', { token: tampered })).status, 401);
    });
    it('403 when role is insufficient; 200 for the right role', async () => {
      assert.equal((await call('GET', '/api/admin/overview', { token: T.c1 })).status, 403);
      assert.equal((await call('GET', '/api/admin/overview', { token: T.v1 })).status, 403);
      assert.equal((await call('GET', '/api/vendor/overview', { token: T.c1 })).status, 403);
      assert.equal((await call('GET', '/api/customer/overview', { token: T.v1 })).status, 403);
      assert.equal((await call('GET', '/api/admin/overview', { token: T.admin })).status, 200);
    });
    it('users cannot elevate themselves via Better Auth update-user or /api/profile', async () => {
      const login1 = await call('POST', '/api/auth/sign-in/email', { body: { email: 'c1@x.com', password: 'Abcdef1' } });
      const cookie = login1.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const up = await fetch(base + '/api/auth/update-user', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
      assert.equal(up.status, 403);
      const up2 = await fetch(base + '/api/auth/update-user', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ subscriptionPlan: 'Premium' }) });
      assert.equal(up2.status, 403);
      assert.equal((await call('PUT', '/api/profile', { token: T.c1, body: { role: 'admin' } })).status, 400);
      assert.equal((await call('PUT', '/api/profile', { token: T.c1, body: { subscriptionPlan: 'Premium' } })).status, 400);
      assert.equal((await call('GET', '/api/me', { token: T.c1 })).json.user.role, 'customer');
    });
    it('profile update works and ignores businessName for customers', async () => {
      const r = await call('PUT', '/api/profile', { token: T.c1, body: { name: 'Cust One Renamed', phone: '0123', businessName: 'Hack Inc' } });
      assert.equal(r.status, 200);
      assert.equal(r.json.user.name, 'Cust One Renamed');
      assert.equal(r.json.user.businessName, null);
    });
  });

  describe('Services, Free-plan limit, moderation, search', () => {
    it('vendor creates up to 3 active services; the 4th is blocked (403)', async () => {
      for (const n of ['A', 'B', 'C']) {
        const r = await call('POST', '/api/vendor/services', { token: T.v1, body: svcBody(n) });
        assert.equal(r.status, 201);
        assert.equal(r.json.service.status, 'Pending');
        ids['svc' + n] = r.json.service.id;
      }
      const r4 = await call('POST', '/api/vendor/services', { token: T.v1, body: svcBody('D') });
      assert.equal(r4.status, 403);
    });
    it('validates service payloads (400) and rejects customers (403)', async () => {
      assert.equal((await call('POST', '/api/vendor/services', { token: T.v2, body: svcBody('bad', { price: -5 }) })).status, 400);
      assert.equal((await call('POST', '/api/vendor/services', { token: T.v2, body: svcBody('bad', { images: [] }) })).status, 400);
      assert.equal((await call('POST', '/api/vendor/services', { token: T.v2, body: svcBody('bad', { category: 'Nope' }) })).status, 400);
      assert.equal((await call('POST', '/api/vendor/services', { token: T.c1, body: svcBody('x') })).status, 403);
    });
    it('pending services are not public; approved ones are', async () => {
      assert.equal((await call('GET', '/api/services')).json.total, 0);
      const ap = await call('PATCH', `/api/admin/services/${ids.svcA}`, { token: T.admin, body: { status: 'Approved' } });
      assert.equal(ap.json.service.status, 'Approved');
      await call('PATCH', `/api/admin/services/${ids.svcB}`, { token: T.admin, body: { status: 'Approved' } });
      const pub = await call('GET', '/api/services');
      assert.equal(pub.json.total, 2);
    });
    it('service details are private (401) and role-aware', async () => {
      assert.equal((await call('GET', `/api/services/${ids.svcA}`)).status, 401);
      assert.equal((await call('GET', `/api/services/${ids.svcA}`, { token: T.c1 })).status, 200);
      assert.equal((await call('GET', `/api/services/${ids.svcC}`, { token: T.c1 })).status, 404); // pending
      assert.equal((await call('GET', `/api/services/${ids.svcC}`, { token: T.v1 })).status, 200); // owner
      assert.equal((await call('GET', '/api/services/not-an-id', { token: T.c1 })).status, 404);
    });
    it('search: multi-term, category, price range, sort, pagination; regex input is safe', async () => {
      await call('PUT', `/api/vendor/services/${ids.svcB}`, { token: T.v1, body: { price: 500, location: 'Chittagong' } });
      await call('PATCH', `/api/admin/services/${ids.svcB}`, { token: T.admin, body: { status: 'Approved' } });
      assert.equal((await call('GET', '/api/services?search=service%20dhaka')).json.total, 1);
      assert.equal((await call('GET', '/api/services?search=' + encodeURIComponent('(.*'))).status, 200);
      assert.equal((await call('GET', '/api/services?category=Wedding%20Venues')).json.total, 0);
      assert.equal((await call('GET', '/api/services?maxPrice=600')).json.total, 1);
      const asc = (await call('GET', '/api/services?sort=price_asc')).json.items.map((s: any) => s.price);
      assert.deepEqual(asc, [...asc].sort((a: number, b: number) => a - b));
      const p = (await call('GET', '/api/services?limit=1&page=2')).json;
      assert.equal(p.items.length, 1);
      assert.equal(p.pages, 2);
    });
    it('editing an Approved service sends it back to Pending review', async () => {
      const r = await call('PUT', `/api/vendor/services/${ids.svcA}`, { token: T.v1, body: { price: 1234 } });
      assert.equal(r.json.service.status, 'Pending');
      await call('PATCH', `/api/admin/services/${ids.svcA}`, { token: T.admin, body: { status: 'Approved' } });
    });
    it('vendors cannot edit/delete other vendors’ services (403) nor self-approve (400)', async () => {
      assert.equal((await call('PUT', `/api/vendor/services/${ids.svcA}`, { token: T.v2, body: { price: 1 } })).status, 403);
      assert.equal((await call('DELETE', `/api/vendor/services/${ids.svcA}`, { token: T.v2 })).status, 403);
      assert.equal((await call('PUT', `/api/vendor/services/${ids.svcA}`, { token: T.v1, body: { status: 'Approved' } })).status, 400);
    });
    it('Free vendor cannot exceed the cap by re-enabling or admin re-approval', async () => {
      await call('PATCH', `/api/admin/services/${ids.svcC}`, { token: T.admin, body: { status: 'Rejected' } });
      const d = await call('POST', '/api/vendor/services', { token: T.v1, body: svcBody('D') });
      assert.equal(d.status, 201); // rejected one freed a slot
      ids.svcD = d.json.service.id;
      const back = await call('PATCH', `/api/admin/services/${ids.svcC}`, { token: T.admin, body: { status: 'Approved' } });
      assert.equal(back.status, 403); // would make 4 active
    });
  });

  describe('Bookings', () => {
    it('customer books; duplicate → 409; past/invalid date → 400; vendor/admin cannot book', async () => {
      const body = { serviceId: ids.svcA, eventDate: futureDate(), eventLocation: 'Dhaka Hall', message: 'Wedding for 200 guests' };
      const r = await call('POST', '/api/customer/bookings', { token: T.c1, body });
      assert.equal(r.status, 201);
      ids.bk1 = r.json.booking.id;
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.c1, body })).status, 409);
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.c1, body: { ...body, eventDate: '2020-01-01' } })).status, 400);
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.c1, body: { ...body, eventDate: '2099-02-30' } })).status, 400);
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.v2, body })).status, 403);
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.admin, body })).status, 403);
      assert.equal((await call('POST', '/api/customer/bookings', { token: T.c1, body: { ...body, serviceId: ids.svcD, eventDate: futureDate(40) } })).status, 400); // pending service
    });
    it('concurrent duplicate requests create only ONE booking (unique index, race-safe)', async () => {
      const body = { serviceId: ids.svcA, eventDate: futureDate(50), eventLocation: 'Sylhet', message: 'Race condition test' };
      const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/customer/bookings', { token: T.c2, body })));
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 5);
    });
    it('only the owning vendor can accept/reject; transitions are single-use', async () => {
      assert.equal((await call('PATCH', `/api/vendor/bookings/${ids.bk1}`, { token: T.v2, body: { status: 'Accepted' } })).status, 403);
      assert.equal((await call('PATCH', `/api/vendor/bookings/${ids.bk1}`, { token: T.v1, body: { status: 'Bogus' } })).status, 400);
      assert.equal((await call('PATCH', `/api/vendor/bookings/${ids.bk1}`, { token: T.v1, body: { status: 'Accepted' } })).json.booking.status, 'Accepted');
      assert.equal((await call('PATCH', `/api/vendor/bookings/${ids.bk1}`, { token: T.v1, body: { status: 'Rejected' } })).status, 409);
    });
    it('customers can cancel only their own PENDING bookings', async () => {
      assert.equal((await call('PATCH', `/api/customer/bookings/${ids.bk1}/cancel`, { token: T.c1 })).status, 409); // accepted
      const mine = (await call('GET', '/api/customer/bookings', { token: T.c2 })).json.items[0];
      assert.equal((await call('PATCH', `/api/customer/bookings/${mine.id}/cancel`, { token: T.c1 })).status, 403);
      assert.equal((await call('PATCH', `/api/customer/bookings/${mine.id}/cancel`, { token: T.c2 })).json.booking.status, 'Cancelled');
    });
    it('lists include joined service/vendor/customer data', async () => {
      const v = (await call('GET', '/api/vendor/bookings', { token: T.v1 })).json.items;
      assert.ok(v.length >= 1 && v[0].service?.serviceName && v[0].customer?.email);
      const c = (await call('GET', '/api/customer/bookings', { token: T.c1 })).json.items;
      assert.ok(c[0].vendor?.name);
    });
  });

  describe('Stripe subscription (webhook-driven)', () => {
    const hook = (type: string, object: any, secret = 'whsec_unit_test_secret') => {
      const payload = JSON.stringify({ id: 'evt_' + Math.random().toString(36).slice(2), object: 'event', type, data: { object } });
      const header = new StripeLib('sk_test_x').webhooks.generateTestHeaderString({ payload, secret });
      return fetch(base + '/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
    };

    it('checkout is unavailable (503) when Stripe is not configured', async () => {
      assert.equal((await call('POST', '/api/vendor/subscription/checkout', { token: T.v1 })).status, 503);
    });
    it('checkout creates a Pending transaction for the AUTHENTICATED vendor only', async () => {
      stripeHolder.client = {
        checkout: { sessions: { create: async (p: any) => { assert.equal(p.client_reference_id, ids.v1); assert.equal(p.mode, 'subscription'); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; } } },
        subscriptions: { update: async () => ({}) },
      };
      const r = await call('POST', '/api/vendor/subscription/checkout', { token: T.v1, body: { vendorId: ids.v2 } }); // body vendorId ignored
      assert.equal(r.status, 200);
      assert.match(r.json.checkoutUrl, /checkout\.stripe\.com/);
      assert.equal((await call('POST', '/api/vendor/subscription/checkout', { token: T.c1 })).status, 403);
      const st = await call('GET', '/api/vendor/subscription/session/cs_test_1', { token: T.v1 });
      assert.equal(st.json.transaction.status, 'Pending');
      assert.equal(st.json.premiumActive, false);
      assert.equal((await call('GET', '/api/vendor/subscription/session/cs_test_1', { token: T.v2 })).status, 403);
    });
    it('rejects webhooks with missing or invalid signatures (400) — nothing is granted', async () => {
      const bad = await fetch(base + '/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: '{"type":"checkout.session.completed"}' });
      assert.equal(bad.status, 400);
      const none = await fetch(base + '/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(none.status, 400);
      const wrongSecret = await hook('checkout.session.completed', { id: 'cs_test_1', mode: 'subscription', payment_status: 'paid', metadata: { vendorId: ids.v1 } }, 'whsec_attacker');
      assert.equal(wrongSecret.status, 400);
      assert.equal((await call('GET', '/api/vendor/overview', { token: T.v1 })).json.subscriptionPlan, 'Free');
    });
    it('a payment redirect alone never grants Premium', async () => {
      assert.equal((await call('GET', '/api/vendor/subscription/session/cs_test_1', { token: T.v1 })).json.premiumActive, false);
    });
    it('verified checkout.session.completed activates Premium and marks the transaction Succeeded (idempotent)', async () => {
      const session = { id: 'cs_test_1', mode: 'subscription', payment_status: 'paid', metadata: { vendorId: ids.v1 }, client_reference_id: ids.v1, subscription: 'sub_test_1', customer: 'cus_test_1', amount_total: 2900, currency: 'usd' };
      assert.equal((await hook('checkout.session.completed', session)).status, 200);
      assert.equal((await hook('checkout.session.completed', session)).status, 200); // replay
      const o = (await call('GET', '/api/vendor/overview', { token: T.v1 })).json;
      assert.equal(o.subscriptionPlan, 'Premium');
      assert.ok(new Date(o.subscriptionExpiresAt).getTime() > Date.now());
      const tx = (await call('GET', '/api/vendor/transactions', { token: T.v1 })).json.items;
      assert.equal(tx.length, 1);
      assert.equal(tx[0].status, 'Succeeded');
      assert.equal(tx[0].amount, 29);
    });
    it('Premium vendor can exceed 3 active services and is ranked first publicly', async () => {
      for (const n of ['E', 'F']) assert.equal((await call('POST', '/api/vendor/services', { token: T.v1, body: svcBody(n) })).status, 201);
      assert.equal((await call('POST', '/api/vendor/checkout', { token: T.v1 })).status, 404);
      assert.equal((await call('POST', '/api/vendor/subscription/checkout', { token: T.v1 })).status, 409); // already premium
      // second vendor with one approved Free service
      const s2 = await call('POST', '/api/vendor/services', { token: T.v2, body: svcBody('Free-vendor', { price: 1 }) });
      ids.svcV2 = s2.json.service.id;
      await call('PATCH', `/api/admin/services/${ids.svcV2}`, { token: T.admin, body: { status: 'Approved' } });
      const list = (await call('GET', '/api/services')).json.items;
      assert.equal(list[0].vendor.subscriptionPlan, 'Premium');
      assert.equal(list[list.length - 1].vendor.subscriptionPlan, 'Free');
    });
    it('invoice.paid sets the exact period end; renewal is recorded as a transaction', async () => {
      const end = Math.floor(Date.now() / 1000) + 31 * 86400;
      const inv = { id: 'in_1', subscription: 'sub_test_1', customer: 'cus_test_1', billing_reason: 'subscription_cycle', amount_paid: 2900, currency: 'usd', lines: { data: [{ period: { end } }] } };
      assert.equal((await hook('invoice.paid', inv)).status, 200);
      assert.equal((await hook('invoice.paid', inv)).status, 200);
      const o = (await call('GET', '/api/vendor/overview', { token: T.v1 })).json;
      assert.equal(Math.floor(new Date(o.subscriptionExpiresAt).getTime() / 1000), end);
      assert.equal((await call('GET', '/api/vendor/transactions', { token: T.v1 })).json.items.length, 2);
    });
    it('vendor can request cancellation; access continues until period end', async () => {
      const r = await call('POST', '/api/vendor/subscription/cancel', { token: T.v1 });
      assert.equal(r.status, 200);
      assert.equal((await call('GET', '/api/vendor/overview', { token: T.v1 })).json.cancelAtPeriodEnd, true);
      assert.equal((await call('POST', '/api/vendor/subscription/cancel', { token: T.v2 })).status, 409);
    });
    it('invoice.payment_failed records a Failed transaction without instantly downgrading', async () => {
      await hook('invoice.payment_failed', { id: 'in_2', subscription: 'sub_test_1', customer: 'cus_test_1', amount_due: 2900, currency: 'usd' });
      assert.equal((await call('GET', '/api/vendor/overview', { token: T.v1 })).json.subscriptionPlan, 'Premium');
      assert.ok((await call('GET', '/api/vendor/transactions', { token: T.v1 })).json.items.some((t: any) => t.status === 'Failed'));
    });
    it('customer.subscription.deleted downgrades to Free and pauses services beyond the Free limit', async () => {
      assert.equal((await hook('customer.subscription.deleted', { id: 'sub_test_1', customer: 'cus_test_1', metadata: { vendorId: ids.v1 } })).status, 200);
      const o = (await call('GET', '/api/vendor/overview', { token: T.v1 })).json;
      assert.equal(o.subscriptionPlan, 'Free');
      const active = (await call('GET', '/api/vendor/services', { token: T.v1 })).json.items.filter((s: any) => s.status !== 'Rejected' && s.isAvailable);
      assert.equal(active.length, 3);
    });
    it('expired Premium is lapsed automatically', async () => {
      const { ObjectId } = await import('mongodb');
      await db.users().updateOne({ _id: new ObjectId(ids.v2) }, { $set: { subscriptionPlan: 'Premium', subscriptionExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call('GET', '/api/vendor/overview', { token: T.v2 })).json.subscriptionPlan, 'Free');
    });
  });

  describe('Admin', () => {
    it('lists/searches users, shows overview and read-only transactions', async () => {
      assert.ok((await call('GET', '/api/admin/users?search=cust', { token: T.admin })).json.items.length >= 2);
      assert.equal((await call('GET', '/api/admin/users?role=vendor', { token: T.admin })).json.items.every((u: any) => u.role === 'vendor'), true);
      const ov = (await call('GET', '/api/admin/overview', { token: T.admin })).json;
      assert.ok(ov.totalUsers >= 6 && ov.totalRevenue >= 29);
      const tx = await call('GET', '/api/admin/transactions', { token: T.admin });
      assert.ok(tx.json.items[0].vendor.email);
      const id = tx.json.items[0].id;
      assert.equal((await call('PATCH', `/api/admin/transactions/${id}`, { token: T.admin, body: { status: 'Failed' } })).status, 404);
      assert.equal((await call('PUT', `/api/admin/transactions/${id}`, { token: T.admin, body: { amount: 1 } })).status, 404);
    });
    it('blocking: cannot block self/admin; blocked user is cut off immediately and cannot log in', async () => {
      const adminId = (await call('GET', '/api/me', { token: T.admin })).json.user.id;
      assert.equal((await call('PATCH', `/api/admin/users/${adminId}/block`, { token: T.admin, body: { isBlocked: true } })).status, 403);
      assert.equal((await call('PATCH', `/api/admin/users/${ids.c2}/block`, { token: T.admin, body: { isBlocked: true } })).status, 200);
      assert.equal((await call('GET', '/api/me', { token: T.c2 })).status, 403); // existing JWT dies immediately
      assert.notEqual((await login('c2@x.com')).res.status, 200);
      assert.equal((await call('PATCH', `/api/admin/users/${ids.c2}/block`, { token: T.admin, body: { isBlocked: false } })).status, 200);
      assert.equal((await login('c2@x.com')).res.status, 200);
    });
    it('blocked vendor’s services disappear from the public catalog', async () => {
      const before = (await call('GET', '/api/services')).json.total;
      assert.ok(before >= 1);
      await call('PATCH', `/api/admin/users/${ids.v2}/block`, { token: T.admin, body: { isBlocked: true } });
      try {
        assert.equal((await call('GET', '/api/services')).json.total, before - 1);
        assert.equal((await call('GET', `/api/services/${ids.svcV2}`, { token: T.c1 })).status, 404);
      } finally {
        await call('PATCH', `/api/admin/users/${ids.v2}/block`, { token: T.admin, body: { isBlocked: false } });
      }
      assert.equal((await call('GET', '/api/services')).json.total, before);
    });
    it('admin can delete a service; its pending bookings are cancelled', async () => {
      const body = { serviceId: ids.svcV2, eventDate: futureDate(60), eventLocation: 'Khulna', message: 'Delete cascade test' };
      const bk = await call('POST', '/api/customer/bookings', { token: T.c1, body });
      assert.equal(bk.status, 201);
      assert.equal((await call('DELETE', `/api/admin/services/${ids.svcV2}`, { token: T.admin })).status, 200);
      const mine = (await call('GET', '/api/customer/bookings', { token: T.c1 })).json.items.find((b: any) => b.id === bk.json.booking.id);
      assert.equal(mine.status, 'Cancelled');
    });
  });

  describe('Uploads & API hygiene', () => {
    it('upload requires auth, accepts real images, rejects fake/oversized/wrong types', async () => {
      assert.equal((await call('POST', '/api/upload', { body: { imageBase64: PNG } })).status, 401);
      const ok = await call('POST', '/api/upload', { token: T.v1, body: { imageBase64: PNG, fileName: 'x.png' } });
      assert.equal(ok.status, 200);
      assert.match(ok.json.url, /^\/api\/uploads\//);
      assert.equal((await call('POST', '/api/upload', { token: T.v1, body: { imageBase64: 'data:image/png;base64,PGh0bWw+PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0PjwvaHRtbD4=' } })).status, 400);
      assert.equal((await call('POST', '/api/upload', { token: T.v1, body: { imageBase64: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })).status, 400);
    });
    it('returns JSON errors for malformed JSON, unknown routes and oversized bodies', async () => {
      const bad = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{bad' });
      assert.ok(bad.status >= 400 && bad.status < 500);
      const nf = await call('GET', '/api/nope');
      assert.equal(nf.status, 404); assert.ok(nf.json.error);
      const big = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.v1}` }, body: JSON.stringify({ imageBase64: 'a'.repeat(9 * 1024 * 1024) }) });
      assert.equal(big.status, 413);
      assert.ok((await big.json()).error);
    });
    it('NoSQL-injection style payloads are treated as plain strings', async () => {
      const r = await call('POST', '/api/auth/sign-in/email', { body: { email: { $ne: '' }, password: { $ne: '' } } });
      assert.ok(r.status >= 400 && r.status < 500);
      assert.equal((await call('GET', '/api/services?category[$ne]=x')).status, 200);
    });
    it('security headers are set and x-powered-by is hidden', async () => {
      const r = await call('GET', '/api/health');
      assert.equal(r.headers.get('x-powered-by'), null);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });
  });
});
