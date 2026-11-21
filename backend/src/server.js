import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase } from './database.js';

try {
  const config = loadConfig();
  await connectDatabase(config.mongoUri);
  const server = createServer({
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    maxHeaderSize: 8192,
  }, createApp(config));
  server.listen(config.port, config.host, () => {
    console.log(`Wallet API listening on port ${config.port}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      });
    });
  }
} catch (error) {
  const detail = error.issues?.map(issue => issue.path.join('.')).join(', ') ?? error.code ?? error.name;
  console.error('Could not start wallet API.', detail);
  await mongoose.disconnect();
  process.exitCode = 1;
}
