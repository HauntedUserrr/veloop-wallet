import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const dbPath = fileURLToPath(new URL('../../.mongo/', import.meta.url));
await mkdir(dbPath, { recursive: true });
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.12' },
  instanceOpts: [{ port: 27017, dbPath, ip: '127.0.0.1' }],
  replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
});
console.log(replica.getUri('veloop_demo'));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await replica.stop({ doCleanup: false });
    process.exit(0);
  });
}
