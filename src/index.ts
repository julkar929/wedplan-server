import { createApp } from './app.js';
import { env } from './config/env.js';
import { client, ensureIndexes } from './db.js';
import { ensureAdmin } from './services/seedAdmin.js';
import { expireLapsedSubscriptions } from './services/subscription.js';

async function main() {
  await client.connect();
  await ensureIndexes();
  await ensureAdmin();
  const app = createApp();
  app.listen(env.PORT, () => console.log(`WedPlan API listening on :${env.PORT} (${env.NODE_ENV})`));
  // Expire lapsed Premium subscriptions hourly (also applied lazily on vendor requests)
  setInterval(() => expireLapsedSubscriptions().catch((e) => console.error('[expiry]', e)), 60 * 60 * 1000).unref();
}

main().catch((e) => {
  console.error('Failed to start WedPlan API:', e);
  process.exit(1);
});
