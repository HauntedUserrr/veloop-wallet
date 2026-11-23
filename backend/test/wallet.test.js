import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase, Ledger, User, Wallet } from '../src/models.js';

const jwtSecret = randomBytes(32).toString('hex');
const api = request(createApp({ jwtSecret, demoEnabled: true }));
let mongo;

before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '8.0.12' }, replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await connectDatabase(mongo.getUri('wallet_tests'));
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function signIn() {
  const { body } = await api.post('/api/auth/demo').expect(201);
  return body;
}

test('creates the wallet from its opening ledger entries', async () => {
  const { token } = await signIn();
  const { body: { wallet } } = await api.get('/api/wallet').auth(token, { type: 'bearer' }).expect(200);
  const { body } = await api.get('/api/wallet/transactions').auth(token, { type: 'bearer' }).expect(200);
  const totals = { ves: 0, sves: 0, gems: 0, tokens: 0, spins: 0 };
  for (const entry of body.records.toReversed()) {
    assert.equal(entry.balanceBefore, totals[entry.currency]);
    totals[entry.currency] += entry.amount;
    assert.equal(entry.balanceAfter, totals[entry.currency]);
  }
  assert.equal(body.records.length, 8);
  assert.deepEqual(totals, { ves: 25000, sves: 5000, gems: 100, tokens: 500, spins: 3 });
  assert.deepEqual(wallet.balances, totals);
});

test('rejects wallet and ledger reads without a valid token', async () => {
  await api.get('/api/wallet').expect(401);
  await api.get('/api/wallet/transactions').auth('invalid', { type: 'bearer' }).expect(401);
});

test('keeps each demo ledger scoped to its signed-in owner', async () => {
  const owner = await signIn();
  const other = await signIn();
  const { body } = await api.get('/api/wallet/transactions').auth(owner.token, { type: 'bearer' }).expect(200);
  assert.ok(body.records.every(record => record.userId === owner.user.id));
  await api.get('/api/wallet/transactions').query({ userId: other.user.id })
    .auth(owner.token, { type: 'bearer' }).expect(422);
});

test('paginates without duplicating entries and validates page limits', async () => {
  const { token } = await signIn();
  const history = (page, limit) => api.get('/api/wallet/transactions')
    .auth(token, { type: 'bearer' }).query({ page, limit });
  const first = (await history(1, 5).expect(200)).body;
  const second = (await history(2, 5).expect(200)).body;
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.records, ...second.records].map(row => row._id)).size, 8);
  await history(0, 5).expect(422);
  await history(1, 51).expect(422);
});

test('a ledger write failure rolls back the demo user and wallet', async () => {
  const oldInsert = Ledger.insertMany;
  const usersBefore = await User.countDocuments();
  const walletsBefore = await Wallet.countDocuments();
  Ledger.insertMany = async () => { throw new Error('Test ledger failure'); };
  try {
    await api.post('/api/auth/demo').expect(500);
  } finally {
    Ledger.insertMany = oldInsert;
  }
  assert.equal(await User.countDocuments(), usersBefore);
  assert.equal(await Wallet.countDocuments(), walletsBefore);
});

test('demo sign-in can be disabled', async () => {
  await request(createApp({ jwtSecret })).post('/api/auth/demo').expect(404);
});
