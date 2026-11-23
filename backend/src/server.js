import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase } from './models.js';

const { MONGO_URI, JWT_SECRET, DEMO_ENABLED, PORT = '4001', HOST = '127.0.0.1' } = process.env;
const port = Number(PORT);
if (!MONGO_URI || !JWT_SECRET || JWT_SECRET.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set MONGO_URI, a JWT_SECRET of at least 32 characters, and a valid PORT.');
  process.exit(1);
}

try {
  await connectDatabase(MONGO_URI);
  const app = createApp({ jwtSecret: JWT_SECRET, demoEnabled: DEMO_ENABLED === 'true' });
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
