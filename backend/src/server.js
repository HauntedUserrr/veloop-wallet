import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase } from './models.js';
import { seedPayoutOptions } from './payout.js';

const { MONGO_URI, JWT_SECRET, PAYOUT_ENCRYPTION_KEY, REVIEWER_TOKEN, DEMO_ENABLED,
  PORT = '4001', HOST = '127.0.0.1', CLIENT_ORIGIN, TRUST_PROXY_HOPS = '0' } = process.env;
const port = Number(PORT);
const trustProxy = Number(TRUST_PROXY_HOPS);
if (!/^[0-9]+$/.test(TRUST_PROXY_HOPS) || !Number.isSafeInteger(trustProxy)) {
  console.error('Set TRUST_PROXY_HOPS to a nonnegative integer.');
  process.exit(1);
}
if (!MONGO_URI || !JWT_SECRET || JWT_SECRET.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set MONGO_URI, a JWT_SECRET of at least 32 characters, and a valid PORT.');
  process.exit(1);
}
if (!/^[a-f\d]{64}$/i.test(PAYOUT_ENCRYPTION_KEY ?? '')) {
  console.error('Set PAYOUT_ENCRYPTION_KEY to a 32-byte key encoded as hex.');
  process.exit(1);
}
if (REVIEWER_TOKEN && REVIEWER_TOKEN.length < 32) {
  console.error('Use a reviewer token of at least 32 characters.');
  process.exit(1);
}

try {
  await connectDatabase(MONGO_URI);
  await seedPayoutOptions();
  const app = createApp({
    jwtSecret: JWT_SECRET,
    payoutKey: Buffer.from(PAYOUT_ENCRYPTION_KEY, 'hex'),
    reviewerToken: REVIEWER_TOKEN,
    demoEnabled: DEMO_ENABLED === 'true',
    clientOrigin: CLIENT_ORIGIN,
    trustProxy,
  });
  const server = app.listen(port, HOST, () => console.log(`Wallet API listening on ${HOST}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    }));
  }
} catch (error) {
  console.error('Could not start wallet API:', error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
}
