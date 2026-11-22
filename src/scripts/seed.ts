/**
 * Demo data for local development / classroom use:  npm run seed
 * Idempotent: users that already exist are reused, services are only created when the vendor has none.
 * All demo accounts use the password printed at the end.
 */
import { ObjectId } from 'mongodb';
import { auth } from '../auth.js';
import { bookings, client, ensureIndexes, services, transactions, users } from '../db.js';
import { ensureAdmin } from '../services/seedAdmin.js';

const PASSWORD = 'Demo1234';
const img = (seed: string) => `https://picsum.photos/seed/${seed}/900/650`;
const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function user(name: string, email: string, role: 'vendor' | 'customer', extra: Record<string, unknown> = {}) {
  let u = await users().findOne({ email });
  if (!u) {
    await auth.api.signUpEmail({ body: { name, email, password: PASSWORD, role, ...(role === 'vendor' ? { businessName: extra.businessName as string } : {}) } as never });
    u = await users().findOne({ email });
  }
  await users().updateOne({ _id: u!._id }, { $set: { emailVerified: true, ...extra } });
  return (await users().findOne({ _id: u!._id }))!;
}

async function main() {
  await client.connect();
  await ensureIndexes();
  await ensureAdmin();

  const elena = await user('Elena Rossi', 'elena@ivorylens.co', 'vendor', { businessName: 'Ivory Lens Studio', location: 'Dhaka', phone: '+8801700000001', bio: 'Award-winning wedding photographers capturing timeless moments.' });
  const rahim = await user('Rahim Chowdhury', 'rahim@royalvenues.bd', 'vendor', {
    businessName: 'Royal Venues BD', location: 'Chittagong', phone: '+8801700000002', bio: 'Premium banquet halls and garden venues.',
    subscriptionPlan: 'Premium', subscriptionExpiresAt: new Date(Date.now() + 25 * 86400000), stripeCustomerId: 'cus_demo_rahim', stripeSubscriptionId: 'sub_demo_rahim',
  });
  const nusrat = await user('Nusrat Jahan', 'nusrat@bloomdecor.bd', 'vendor', { businessName: 'Bloom & Co. Decor', location: 'Sylhet', phone: '+8801700000003', bio: 'Floral design and stage decoration.' });
  const claire = await user('Claire Bennett', 'claire@example.com', 'customer', { location: 'Dhaka' });
  const tanvir = await user('Tanvir Ahmed', 'tanvir@example.com', 'customer', { location: 'Rajshahi' });
  await user('Mim Akter', 'mim@example.com', 'customer');

  const catalog: Array<[typeof elena, string, string, string, number, string, 'Approved' | 'Pending']> = [
    [elena, 'Cinematic Wedding Photography', 'Photography & Videography', 'Full-day coverage with two photographers, a cinematic highlight film, and a premium album. Includes engagement shoot and drone footage.', 2200, 'Dhaka', 'Approved'],
    [elena, 'Pre-Wedding Story Session', 'Photography & Videography', 'A relaxed half-day pre-wedding session in two locations with 60 edited photos and a short teaser reel for your guests.', 650, 'Dhaka', 'Approved'],
    [rahim, 'Lakeside Garden Banquet Hall', 'Wedding Venues', 'Elegant lakeside venue for up to 400 guests with a bridal suite, ample parking, in-house lighting and a dedicated event manager.', 9000, 'Chittagong', 'Approved'],
    [rahim, 'Royal Grand Ballroom', 'Wedding Venues', 'Air-conditioned grand ballroom with crystal chandeliers, LED stage and valet service. Seats 600 for a formal reception.', 12000, 'Chittagong', 'Approved'],
    [rahim, 'Heritage Courtyard Estate', 'Wedding Venues', 'A restored heritage courtyard for intimate ceremonies of up to 120 guests, ideal for holud and mehendi evenings.', 5200, 'Dhaka', 'Pending'],
    [nusrat, 'Floral Stage & Entrance Design', 'Decoration & Florist', 'Custom floral stage, aisle, and entrance gate design using fresh seasonal flowers. Setup and teardown included.', 1800, 'Sylhet', 'Approved'],
    [nusrat, 'Bridal Bouquet & Car Decoration', 'Decoration & Florist', 'Hand-tied bridal bouquet, boutonnieres, and a fully decorated wedding car in your chosen palette.', 400, 'Sylhet', 'Approved'],
    [elena, 'Signature Wedding Feast Catering', 'Catering Services', 'Traditional and continental menus for 100–500 guests, with live counters, professional staff and complete tableware.', 3500, 'Dhaka', 'Approved'],
    [nusrat, 'Bridal Makeup & Styling', 'Makeup & Styling', 'Long-lasting bridal makeup, hairstyling, and saree draping with a trial session and touch-up kit for the day.', 550, 'Dhaka', 'Approved'],
    [rahim, 'Designer Sherwani & Lehenga Rental', 'Wedding Fashion', 'Curated collection of designer sherwanis and bridal lehengas with tailoring adjustments and dry-cleaning included.', 700, 'Chittagong', 'Approved'],
  ];

  const made: ObjectId[] = [];
  for (const [v, serviceName, category, description, price, location, status] of catalog) {
    const exists = await services().findOne({ vendorId: String(v._id), serviceName });
    if (exists) { made.push(exists._id); continue; }
    const now = new Date();
    const r = await services().insertOne({
      vendorId: String(v._id), serviceName, category: category as never, description, price, location,
      images: [img(serviceName.toLowerCase().replace(/[^a-z]+/g, '-') + '-1'), img(serviceName.toLowerCase().replace(/[^a-z]+/g, '-') + '-2')],
      status, isAvailable: true, createdAt: now, updatedAt: now,
    } as never);
    made.push(r.insertedId);
  }

  if ((await bookings().countDocuments({})) === 0) {
    const mk = (s: ObjectId, vendor: typeof elena, c: typeof claire, d: number, status: string, loc: string, message: string) =>
      bookings().insertOne({ serviceId: String(s), vendorId: String(vendor._id), customerId: String(c._id), eventDate: days(d), eventLocation: loc, message, status, createdAt: new Date(), updatedAt: new Date() } as never);
    await mk(made[0], elena, claire, 45, 'Pending', 'Dhaka Club', 'Looking for full-day coverage for our wedding of 250 guests.');
    await mk(made[2], rahim, claire, 90, 'Accepted', 'Chittagong', 'We would love to hold our reception at your lakeside hall.');
    await mk(made[5], nusrat, tanvir, 60, 'Rejected', 'Sylhet', 'Need stage decoration for a holud ceremony.');
    await mk(made[7], elena, tanvir, 75, 'Pending', 'Rajshahi', 'Catering for 300 guests, Bangladeshi menu.');
  }

  if ((await transactions().countDocuments({})) === 0) {
    await transactions().insertMany([
      { vendorId: String(rahim._id), plan: 'Premium', amount: 29, currency: 'usd', stripeSessionId: 'cs_demo_001', stripeSubscriptionId: 'sub_demo_rahim', status: 'Succeeded', createdAt: new Date(Date.now() - 5 * 86400000) },
      { vendorId: String(elena._id), plan: 'Premium', amount: 29, currency: 'usd', stripeSessionId: 'cs_demo_002', status: 'Failed', createdAt: new Date(Date.now() - 2 * 86400000) },
    ] as never);
  }

  console.log('\nDemo data ready. Accounts (password for demo users: ' + PASSWORD + '):');
  console.log('  Admin    ' + (process.env.ADMIN_EMAIL || '(set ADMIN_EMAIL)') + '  /  ADMIN_PASSWORD from .env');
  console.log('  Vendor   elena@ivorylens.co   (Free)');
  console.log('  Vendor   rahim@royalvenues.bd (Premium)');
  console.log('  Vendor   nusrat@bloomdecor.bd (Free)');
  console.log('  Customer claire@example.com, tanvir@example.com, mim@example.com');
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
