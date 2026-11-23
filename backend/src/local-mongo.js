import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const dbPath = fileURLToPath(new URL('../../.mongo/', import.meta.url));
await mkdir(dbPath, { recursive: true });
const mongo = await MongoMemoryReplSet.create({
  binary: { version: '8.0.12' },
  instanceOpts: [{ ip: '127.0.0.1', port: 27018, dbPath }],
  replSet: { name: 'wallet', count: 1, storageEngine: 'wiredTiger' },
});
console.log(mongo.getUri('veloop_rebuild'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await mongo.stop({ doCleanup: false });
    process.exit(0);
  });
}
