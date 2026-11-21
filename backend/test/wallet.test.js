import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword, rotateAdminPassword } from '../src/auth.js';
import { seedCatalog } from '../src/catalog.js';
import { purgeExpiredDemoUsers } from '../src/cleanup-demo-users.js';
import { connectDatabase } from '../src/database.js';
import { AuditLog, Ledger, PayoutOption, RequestBudget, User, Wallet, Withdrawal } from '../src/models.js';
import { paginate } from '../src/services/wallet.js';
import { WithdrawalIntent } from '../src/withdrawal-intent.js';

const config = {
  demo: true, jwtSecret: randomBytes(48).toString('hex'), payoutKey: randomBytes(32),
  origins: ['http://localhost:5173'], trustProxy: 0,
};
const app = request(createApp(config));
let mongo;
let administrator;

before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '8.0.12' },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await connectDatabase(mongo.getUri('veloop_tests'));
  await seedCatalog();
  await PayoutOption.create({
    _id: 'upi_test_1000', method: 'upi', currency: 'ves', requiredAmount: 1000, payoutMinor: 1000, active: true,
  });
  await PayoutOption.create({
    _id: 'upi_test_8000', method: 'upi', currency: 'ves', requiredAmount: 8000, payoutMinor: 4000, active: true,
  });
  const password = 'test-only-password-01';
  await User.create({
    email: 'admin@veloop.test', name: 'Test administrator', role: 'ADMIN', passwordHash: await hashPassword(password),
  });
  administrator = (await app.post('/api/auth/login').send({ email: 'admin@veloop.test', password }).expect(200)).body;
});

after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

async function demo(balance = 25_000) {
  const { body: session } = await app.post('/api/auth/demo').send({}).expect(201);
  if (balance !== 25_000) await adjust(session, 'debit', 25_000 - balance).expect(201);
  return session;
}

function adjust(session, type, amount, referenceId = randomUUID()) {
  return app.post(`/api/wallet/${type}`).auth(administrator.token, { type: 'bearer' }).send({
    userId: session.user.id, currency: 'ves', amount, description: 'Test adjustment', referenceId,
    source: type === 'credit' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
  });
}

const defaultQuote = {
  method: 'upi', optionId: 'upi_test_1000', payoutDetail: 'demo@sample',
  expectedRequiredAmount: 1000, expectedPayoutMinor: 1000,
};

function withdraw(session, overrides = {}, key = randomUUID()) {
  return app.post('/api/withdrawals').auth(session.token, { type: 'bearer' })
    .set('Idempotency-Key', key).send({ ...defaultQuote, ...overrides });
}

function review(id, status, reason) {
  return app.patch(`/api/admin/withdrawals/${id}`).auth(administrator.token, { type: 'bearer' })
    .send({ status, ...(reason && { reason }) });
}

async function wallet(session) {
  const { body } = await app.get('/api/wallet').auth(session.token, { type: 'bearer' }).expect(200);
  return body.wallet.balances;
}

test('credits 500 to 1,000 VEs and records the ledger and audit entries', async () => {
  const session = await demo(1000);
  const { body } = await adjust(session, 'credit', 500).expect(201);
  assert.equal(body.transaction.balanceBefore, 1000);
  assert.equal(body.transaction.balanceAfter, 1500);
  assert.equal((await wallet(session)).ves, 1500);
  assert.ok(await AuditLog.exists({ action: 'WALLET_CREDIT', referenceId: body.transaction._id }));
});

test('deducts 1,000 from 1,500 VEs, creates a pending withdrawal and keeps details private', async () => {
  const session = await demo(1500);
  const { body } = await withdraw(session).expect(201);
  const item = body.withdrawal;
  assert.equal(item.status, 'PENDING');
  assert.equal((await wallet(session)).ves, 500);
  assert.equal((await Ledger.findById(item.transactionId)).balanceAfter, 500);
  assert.ok(await AuditLog.exists({ action: 'WITHDRAWAL_CREATED', referenceId: item.id }));
  assert.equal(item.payoutDetails, undefined);
  const stored = await Withdrawal.findById(item.id).select('+payoutDetails');
  assert.match(stored.payoutDetails, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const [iv, tag, ciphertext] = stored.payoutDetails.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', config.payoutKey, iv);
  decipher.setAAD(Buffer.from(item.id));
  decipher.setAuthTag(tag);
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'), 'sandbox');
  const history = await app.get('/api/withdrawals').auth(session.token, { type: 'bearer' }).expect(200);
  assert.equal(history.body.records[0].id, item.id);
  assert.equal(history.body.records[0].payoutDetails, undefined);
});

test('rejects insufficient funds with no new withdrawal or debit', async () => {
  const session = await demo(500);
  const { body } = await withdraw(session).expect(409);
  assert.equal(body.code, 'INSUFFICIENT_BALANCE');
  assert.equal((await wallet(session)).ves, 500);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 0);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, source: 'WITHDRAWAL' }), 0);
});

test('replays a duplicate submission once and rejects key reuse with changed details', async () => {
  const session = await demo(2000);
  const key = randomUUID();
  const responses = await Promise.all([withdraw(session, {}, key), withdraw(session, {}, key)]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
  assert.equal(responses[0].body.withdrawal.id, responses[1].body.withdrawal.id);
  assert.equal((await wallet(session)).ves, 1000);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 1);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, source: 'WITHDRAWAL' }), 1);
  const replay = await withdraw(session, { payoutDetail: 'different@sample' }, key).expect(409);
  assert.equal(replay.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('allows only one of two concurrent 8,000 VE withdrawals against 10,000 VEs', async () => {
  const session = await demo(10_000);
  const quote = { optionId: 'upi_test_8000', expectedRequiredAmount: 8000, expectedPayoutMinor: 4000 };
  const result = await Promise.all([withdraw(session, quote), withdraw(session, quote)]);
  assert.deepEqual(result.map(response => response.status).sort(), [201, 409]);
  assert.equal((await wallet(session)).ves, 2000);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 1);
});

test('rejects an invalid option, disabled method, and invalid method details', async () => {
  const session = await demo();
  const missing = await withdraw(session, { optionId: 'missing_option' }).expect(422);
  assert.equal(missing.body.code, 'OPTION_UNAVAILABLE');
  const inactive = await withdraw(session, { method: 'paypal' }).expect(422);
  assert.equal(inactive.body.code, 'METHOD_UNAVAILABLE');
  const invalid = await withdraw(session, { payoutDetail: 'bad-details' }).expect(422);
  assert.equal(invalid.body.code, 'INVALID_DETAILS');
});

test('rejects wallet impersonation, cross-user withdrawal access, and user credit attempts', async () => {
  await app.get('/api/wallet').expect(401);
  const owner = await demo();
  const visitor = await demo();
  const { body } = await withdraw(owner).expect(201);
  await app.get(`/api/wallet?userId=${owner.user.id}`).auth(visitor.token, { type: 'bearer' }).expect(400);
  await app.get(`/api/withdrawals/${body.withdrawal.id}`).auth(visitor.token, { type: 'bearer' }).expect(404);
  await app.post('/api/wallet/credit').auth(visitor.token, { type: 'bearer' }).send({}).expect(403);
});

test('reverses rejected withdrawals exactly once even on concurrent admin retries', async () => {
  const session = await demo(1500);
  const { body } = await withdraw(session).expect(201);
  const { id } = body.withdrawal;
  const results = await Promise.all([review(id, 'REJECTED', 'Test rejection'), review(id, 'REJECTED', 'Test rejection')]);
  assert.deepEqual(results.map(response => response.status), [200, 200]);
  assert.equal(results[0].body.withdrawal.status, 'REJECTED');
  assert.equal((await wallet(session)).ves, 1500);
  assert.equal(await Ledger.countDocuments({ referenceId: id, source: 'WITHDRAWAL_REVERSAL' }), 1);
  assert.equal(await AuditLog.countDocuments({ referenceId: id, action: 'WITHDRAWAL_REJECTED' }), 1);
  await review(id, 'PROCESSING').expect(409);
});

test('rejects client-supplied pricing, and uses the catalog when the quote matches', async () => {
  const session = await demo(2500);
  await withdraw(session, { amount: 1 }).expect(422);
  const mismatch = await withdraw(session, { expectedRequiredAmount: 1 }).expect(409);
  assert.equal(mismatch.body.code, 'QUOTE_CHANGED');
  assert.equal((await wallet(session)).ves, 2500);
  const { body } = await withdraw(session).expect(201);
  assert.equal(body.withdrawal.currencyAmount, 1000);
});

test('rejects review-flagged accounts and completes a valid approval without refunding', async () => {
  const session = await demo();
  await User.updateOne({ _id: session.user.id }, { status: 'REVIEW' });
  const { body: { method } } = await app.get('/api/payout/options/upi')
    .auth(session.token, { type: 'bearer' }).expect(200);
  assert.equal(method.eligible, false);
  assert.deepEqual(method.options, []);
  await withdraw(session).expect(403);
  await User.updateOne({ _id: session.user.id }, { status: 'ACTIVE' });
  const { body } = await withdraw(session).expect(201);
  const { id } = body.withdrawal;
  await review(id, 'APPROVED').expect(409);
  await review(id, 'PROCESSING').expect(200);
  const approved = await review(id, 'APPROVED').expect(200);
  assert.equal(approved.body.withdrawal.status, 'APPROVED');
  assert.equal((await wallet(session)).ves, 24_000);
});

test('rejects duplicate exchange references across currency pairs and paginates seeded data', async () => {
  const session = await demo();
  const exchange = (fromCurrency, toCurrency) => app.post('/api/wallet/exchange').auth(administrator.token, { type: 'bearer' }).send({
    userId: session.user.id, fromCurrency, toCurrency, fromAmount: 10, toAmount: 100,
    referenceId: 'exchange-rollback-demo', description: 'Demo exchange',
  });
  await exchange('gems', 'ves').expect(201);
  await exchange('tokens', 'sves').expect(409);
  const balances = await wallet(session);
  assert.equal(balances.ves, 25_100);
  assert.equal(balances.gems, 90);
  assert.equal(balances.tokens, 500);
  assert.equal(balances.sves, 5000);
  const first = await app.get('/api/wallet/transactions?page=1&limit=3').auth(session.token, { type: 'bearer' }).expect(200);
  const second = await app.get('/api/wallet/transactions?page=2&limit=3').auth(session.token, { type: 'bearer' }).expect(200);
  assert.equal(first.body.pagination.hasMore, true);
  assert.equal(new Set([...first.body.records, ...second.body.records].map(record => record._id)).size, 6);
});

test('retains enough balance headroom to refund the full pending debit', async () => {
  const session = await demo();
  const { body } = await withdraw(session).expect(201);
  const ceiling = Number.MAX_SAFE_INTEGER;
  const denied = await adjust(session, 'credit', ceiling - 24_000).expect(409);
  assert.equal(denied.body.code, 'BALANCE_LIMIT');
  assert.equal((await wallet(session)).ves, 24_000);
  await adjust(session, 'credit', ceiling - 25_000).expect(201);
  await review(body.withdrawal.id, 'REJECTED', 'Test refund').expect(200);
  assert.equal((await wallet(session)).ves, ceiling);
});

test('revokes demo sessions across API instances on sign-out', async () => {
  const session = await demo();
  await User.updateOne({ _id: session.user.id }, { $unset: { sessionVersion: 1 } });
  const otherApp = request(createApp(config));
  const auth = { type: 'bearer' };
  await otherApp.get('/api/wallet').auth(session.token, auth).expect(200);
  await app.post('/api/auth/logout').auth(session.token, auth).expect(200);
  await otherApp.get('/api/wallet').auth(session.token, auth).expect(401);
});

test('requires a fresh sign-in after a role change', async () => {
  const session = await demo();
  await User.updateOne({ _id: session.user.id }, { role: 'ADMIN' });
  await app.get('/api/admin/withdrawals').auth(session.token, { type: 'bearer' }).expect(401);
});

test('recovers a committed withdrawal by key only for its owner', async () => {
  const owner = await demo();
  const other = await demo();
  const key = randomUUID();
  const { body } = await withdraw(owner, {}, key).expect(201);
  const receipt = session => app.get('/api/withdrawals/attempt').auth(session.token, { type: 'bearer' })
    .set('Idempotency-Key', key);
  await receipt(other).expect(404);
  assert.equal((await receipt(owner).expect(200)).body.withdrawal.id, body.withdrawal.id);
});

test('rejects unapproved origins before creating a demo wallet', async () => {
  const beforeCount = await User.countDocuments({ demo: true });
  await app.post('/api/auth/demo').set('Origin', 'https://untrusted.example').send({}).expect(403);
  assert.equal(await User.countDocuments({ demo: true }), beforeCount);
  const allowed = await app.options('/api/withdrawals').set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'POST').expect(204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
});

test('shares a source-aware login budget without locking the same account out from another source', async () => {
  const proxyConfig = { ...config, trustProxy: 1 };
  const [first, second] = [request(createApp(proxyConfig)), request(createApp(proxyConfig))];
  const email = 'admin@veloop.test';
  const credentials = { email, password: 'test-only-password-02' };
  const from = (instance, ip) => instance.post('/api/auth/login').set('X-Forwarded-For', ip);
  for (const instance of [first, second]) {
    for (let i = 0; i < 6; i += 1) {
      await from(instance, '192.0.2.1').send(credentials).expect(401);
    }
  }
  const limited = await from(second, '192.0.2.1').send({ ...credentials, email: email.toUpperCase() }).expect(429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  const allowed = await from(second, '192.0.2.2').send({ email, password: 'test-only-password-01' }).expect(200);
  assert.equal(allowed.body.user.id, administrator.user.id);
});

test('shares a withdrawal budget across API instances', async () => {
  const session = await demo();
  const other = request(createApp(config));
  const window = Math.floor(Date.now() / 60_000);
  await RequestBudget.insertMany([window, window + 1].map(bucket => ({
    _id: `withdrawal:${session.user.id}:${bucket}`, hits: 11, expiresAt: new Date((bucket + 1) * 60_000),
  })));
  const key = randomUUID();
  await withdraw(session, {}, key).expect(201);
  if (Math.floor(Date.now() / 60_000) !== window) {
    const retry = await withdraw(session, {}, key);
    assert.ok([200, 429].includes(retry.status));
  }
  const blocking = await other.post('/api/withdrawals').auth(session.token, { type: 'bearer' })
    .set('Idempotency-Key', key).send(defaultQuote).expect(429);
  assert.equal(blocking.body.code, 'RATE_LIMITED');
});

test('rolls back a withdrawal debit if a later transaction step fails', async () => {
  const session = await demo();
  const create = Withdrawal.create;
  Withdrawal.create = async () => { throw Object.assign(new Error('Simulated write failure'), { code: 'TEST_FAILURE' }) };
  try {
    await withdraw(session).expect(500);
  } finally {
    Withdrawal.create = create;
  }
  assert.equal((await Wallet.findById(session.user.id)).balances.ves, 25_000);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, source: 'WITHDRAWAL' }), 0);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 0);
});

test('configures a verified method and new option with admin access and audits every change', async () => {
  const { body: session } = await request(createApp(config)).post('/api/auth/demo').send({}).expect(201);
  const admin = { Authorization: `Bearer ${administrator.token}` };
  const user = { Authorization: `Bearer ${session.token}` };
  const methodsPath = '/api/admin/payout/methods/paypal';
  const option = {
    id: 'paypal_test_10', method: 'paypal', currency: 'ves',
    requiredAmount: 2500, payoutMinor: 1000, active: true,
  };

  await app.post('/api/admin/payout/options').set(user).send(option).expect(403);
  const missing = await app.patch(methodsPath).set(admin).send({ active: true }).expect(409);
  assert.equal(missing.body.code, 'METHOD_HAS_NO_OPTIONS');
  await app.post('/api/admin/payout/options').set(admin).send({ ...option, method: 'missing_method' }).expect(404);
  await app.post('/api/admin/payout/options').set(admin).send(option).expect(201);
  const duplicate = await app.post('/api/admin/payout/options').set(admin).send(option).expect(409);
  assert.equal(duplicate.body.code, 'OPTION_EXISTS');
  const unavailable = await app.get('/api/payout/options/paypal').set(user).expect(200);
  assert.equal(unavailable.body.method.active, false);
  assert.deepEqual(unavailable.body.method.options, []);

  const configuration = { active: true, regions: ['IN'], detailType: 'EMAIL', detailLabel: 'Payout email' };
  await app.patch(methodsPath).set(admin).send(configuration).expect(200);
  await app.patch(methodsPath).set(admin).send(configuration).expect(200);
  const enabled = await app.get('/api/payout/options/paypal').set(user).expect(200);
  assert.equal(enabled.body.method.eligible, true);
  assert.equal(enabled.body.method.detailLabel, 'Payout email');
  assert.equal(enabled.body.method.options[0].requiredAmount, 2500);
  assert.equal(await AuditLog.countDocuments({ referenceId: 'paypal', action: 'PAYOUT_CONFIGURATION_CHANGED' }), 1);
  assert.equal(await AuditLog.countDocuments({ referenceId: option.id, action: 'PAYOUT_CONFIGURATION_CHANGED' }), 1);

  const { body } = await withdraw(session, {
    method: 'paypal', optionId: option.id, expectedRequiredAmount: 2500, payoutDetail: 'demo@example.test',
  }).expect(201);
  const summary = await app.get('/api/wallet/summary').set(user).expect(200);
  assert.equal(summary.body.wallet.balances.ves, 22_500);
  assert.equal(summary.body.recentTransactions[0]._id, body.withdrawal.transactionId);
  assert.equal(summary.body.recentTransactions[0].balanceAfter, summary.body.wallet.balances.ves);
  const pending = await app.get(`/api/admin/withdrawals?status=PENDING&userId=${session.user.id}`).set(admin).expect(200);
  assert.deepEqual(pending.body.records.map(item => item.id), [body.withdrawal.id]);
  await review(body.withdrawal.id, 'REJECTED', 'Test reversal').expect(200);
  const filtered = await app.get(`/api/admin/withdrawals?status=PENDING&userId=${session.user.id}`).set(admin).expect(200);
  assert.deepEqual(filtered.body.records, []);
  assert.equal((await wallet(session)).ves, 25_000);
});

function demoForTest() {
  return request(createApp(config)).post('/api/auth/demo').send({}).expect(201).then(response => response.body);
}

function intent(session, method, key, body = defaultQuote) {
  const result = app[method]('/api/withdrawals/intents').auth(session.token, { type: 'bearer' })
    .set('Idempotency-Key', key);
  return method === 'post' ? result.send(body) : result;
}

test('blocks processing and approval for a newly ineligible owner while preserving the refund path', async () => {
  const session = await demoForTest();
  const { body } = await withdraw(session).expect(201);
  const id = body.withdrawal.id;
  await User.updateOne({ _id: session.user.id }, { status: 'REVIEW' });
  await review(id, 'PROCESSING').expect(403);
  await User.updateOne({ _id: session.user.id }, { status: 'ACTIVE' });
  await review(id, 'PROCESSING').expect(200);
  await User.updateOne({ _id: session.user.id }, { status: 'SUSPENDED' });
  await review(id, 'APPROVED').expect(403);
  await review(id, 'REJECTED', 'Account requires review').expect(200);
  assert.equal((await Wallet.findById(session.user.id)).balances.ves, 25_000);
});

test('binds a browser withdrawal to the original details before submission and recovers one committed debit', async () => {
  const session = await demoForTest();
  const key = `wd1-${Date.now()}-${randomUUID()}`;
  await intent(session, 'post', key).expect(200);
  const changed = { payoutDetail: 'other@sample' };
  await intent(session, 'post', key, { ...defaultQuote, ...changed }).expect(409);
  await intent(session, 'post', key, { ...defaultQuote, expectedPayoutMinor: 2500 }).expect(409);
  await withdraw(session, changed, key).expect(409);
  assert.equal((await wallet(session)).ves, 25_000);
  const committed = await withdraw(session, {}, key).expect(201);
  const retry = await withdraw(session, {}, key).expect(200);
  assert.equal(retry.body.withdrawal.id, committed.body.withdrawal.id);
  assert.equal((await wallet(session)).ves, 24_000);
  const abandon = await intent(session, 'delete', key).expect(200);
  assert.equal(abandon.body.abandoned, false);
  assert.equal(abandon.body.withdrawal.id, committed.body.withdrawal.id);
});

test('abandons an uncommitted intent without allowing a late request to deduct funds', async () => {
  const session = await demoForTest();
  const key = `wd1-${Date.now()}-${randomUUID()}`;
  await intent(session, 'post', key).expect(200);
  const abandoned = await intent(session, 'delete', key).expect(200);
  assert.equal(abandoned.body.abandoned, true);
  const late = await withdraw(session, {}, key);
  assert.ok([409, 410].includes(late.status));
  assert.equal((await wallet(session)).ves, 25_000);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 0);
});

test('serializes a discard and debit submitted concurrently for the same intent', async () => {
  const session = await demoForTest();
  const key = `wd1-${Date.now()}-${randomUUID()}`;
  await intent(session, 'post', key).expect(200);
  const [submission, discard] = await Promise.all([
    withdraw(session, {}, key),
    intent(session, 'delete', key).expect(200),
  ]);
  if (submission.status === 201) {
    assert.equal(discard.body.abandoned, false);
    assert.equal(discard.body.withdrawal.id, submission.body.withdrawal.id);
    assert.equal((await wallet(session)).ves, 24_000);
  } else {
    assert.equal(submission.body.code, 'INTENT_ABANDONED');
    assert.equal(discard.body.abandoned, true);
    assert.equal((await wallet(session)).ves, 25_000);
  }
});

test('rotates an administrator password and invalidates existing tokens', async () => {
  const email = 'rotating-admin@veloop.test';
  const oldPassword = `test-only-${randomUUID()}`;
  const newPassword = `test-only-${randomUUID()}`;
  const loginApp = request(createApp({ ...config, trustProxy: 1 }));
  const login = password => loginApp.post('/api/auth/login').set('X-Forwarded-For', '192.0.2.3').send({ email, password });
  await User.create({ email, name: 'Rotation test', role: 'ADMIN', passwordHash: await hashPassword(oldPassword) });
  const oldSession = (await login(oldPassword).expect(200)).body;
  await rotateAdminPassword(email, newPassword);
  await app.get('/api/admin/withdrawals').auth(oldSession.token, { type: 'bearer' }).expect(401);
  await login(oldPassword).expect(401);
  const newSession = (await login(newPassword).expect(200)).body;
  await app.get('/api/admin/withdrawals').auth(newSession.token, { type: 'bearer' }).expect(200);
});

test('uses a paginated wallet snapshot and stops pagination at the API boundary', async () => {
  const session = await demoForTest();
  const summary = await app.get('/api/wallet/summary?page=2&limit=2').auth(session.token, { type: 'bearer' }).expect(200);
  assert.equal(summary.body.wallet.balances.ves, 25_000);
  assert.equal(summary.body.recentTransactions.length, 2);
  assert.deepEqual(summary.body.pagination, { page: 2, limit: 2, hasMore: true });
  const query = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean() { return [{}, {}, {}]; },
  };
  const last = await paginate(query, {}, { page: 500, limit: 2 });
  assert.equal(last.pagination.hasMore, false);
  await app.get('/api/wallet/summary?page=501').auth(session.token, { type: 'bearer' }).expect(422);
});

test('keeps dry-run data intact and removes only expired sandbox data when cleanup is applied', async () => {
  const session = await demoForTest();
  const other = await demoForTest();
  await withdraw(session).expect(201);
  const key = `wd1-${Date.now()}-${randomUUID()}`;
  await intent(session, 'post', key).expect(200);
  const userId = new mongoose.Types.ObjectId(session.user.id);
  await User.collection.updateOne({ _id: userId }, {
    $set: { createdAt: new Date(Date.now() - 8 * 86_400_000), updatedAt: new Date(Date.now() - 8 * 86_400_000) },
  });
  const planned = await purgeExpiredDemoUsers({ days: 7 });
  assert.equal(planned.matched, 1);
  assert.ok(await User.exists({ _id: userId }));
  const purged = await purgeExpiredDemoUsers({ days: 7, apply: true });
  assert.equal(purged.deleted, 1);
  assert.equal(await User.exists({ _id: userId }), null);
  assert.equal(await Wallet.exists({ _id: userId }), null);
  assert.equal(await Ledger.exists({ userId }), null);
  assert.equal(await Withdrawal.exists({ userId }), null);
  assert.equal(await WithdrawalIntent.exists({ userId }), null);
  assert.equal(await AuditLog.exists({ targetUserId: userId }), null);
  assert.ok(await User.exists({ _id: other.user.id }));
  assert.ok(await User.exists({ _id: administrator.user.id, role: 'ADMIN' }));
});

test('preserves review decisions in a private chronological withdrawal history', async () => {
  const session = await demoForTest();
  const { body } = await withdraw(session).expect(201);
  const id = body.withdrawal.id;
  const auditPath = `/api/admin/withdrawals/${id}/audit`;
  const adminAuth = { Authorization: `Bearer ${administrator.token}` };
  const userAuth = { Authorization: `Bearer ${session.token}` };
  const note = 'Checked the sandbox destination';
  const reason = 'Demo review declined';

  await app.patch(`/api/admin/withdrawals/${id}`).set(adminAuth).send({ status: 'PROCESSING', note }).expect(200);
  await review(id, 'REJECTED', reason).expect(200);
  await review(id, 'REJECTED', 'Duplicate review').expect(200);
  await app.get(auditPath).set(userAuth).expect(403);
  await app.get(`/api/admin/withdrawals/${new mongoose.Types.ObjectId()}/audit`).set(adminAuth).expect(404);

  const { body: { history } } = await app.get(auditPath).set(adminAuth).expect(200);
  assert.deepEqual(history.map(event => event.status), ['PENDING', 'PROCESSING', 'REJECTED']);
  assert.equal(history[1].actorId, administrator.user.id);
  assert.equal(history[1].note, note);
  assert.equal(history[2].reason, reason);
  assert.ok(history[2].refundTransactionId);
  assert.equal((await Withdrawal.findById(id).select('+reviewNote')).reviewNote, note);
  const { body: { withdrawal } } = await app.get(`/api/withdrawals/${id}`).set(userAuth).expect(200);
  assert.equal(withdrawal.reviewNote, undefined);
  assert.equal(withdrawal.rejectionReason, reason);
});

test('reconciles the five currencies exactly and reports balance drift without changing it', async () => {
  const session = await demoForTest();
  const path = `/api/admin/wallet/${session.user.id}/reconciliation`;
  const adminAuth = { Authorization: `Bearer ${administrator.token}` };
  await app.get(path).auth(session.token, { type: 'bearer' }).expect(403);
  await app.get(`/api/admin/wallet/${new mongoose.Types.ObjectId()}/reconciliation`).set(adminAuth).expect(404);

  const { body } = await withdraw(session).expect(201);
  const pending = (await app.get(path).set(adminAuth).expect(200)).body.reconciliation;
  assert.equal(pending.balanced, true);
  assert.equal(pending.currencies.ves.credits, '25000');
  assert.equal(pending.currencies.ves.debits, '1000');
  assert.equal(pending.currencies.ves.expected, '24000');
  await review(body.withdrawal.id, 'REJECTED', 'Demo reversal').expect(200);
  await adjust(session, 'credit', Number.MAX_SAFE_INTEGER - 25_000).expect(201);

  const restored = (await app.get(path).set(adminAuth).expect(200)).body.reconciliation;
  assert.equal(restored.balanced, true);
  assert.equal(restored.currencies.ves.expected, String(Number.MAX_SAFE_INTEGER));
  assert.equal(restored.currencies.ves.actual, String(Number.MAX_SAFE_INTEGER));
  assert.equal(restored.currencies.ves.difference, '0');
  assert.equal(restored.currencies.spins.expected, '3');

  // This fixture intentionally creates drift in the isolated test database.
  await Wallet.updateOne({ _id: session.user.id }, { $inc: { 'balances.gems': 1 } });
  const drift = (await app.get(path).set(adminAuth).expect(200)).body.reconciliation;
  assert.equal(drift.balanced, false);
  assert.equal(drift.currencies.gems.expected, '100');
  assert.equal(drift.currencies.gems.actual, '101');
  assert.equal(drift.currencies.gems.difference, '1');
  assert.equal((await Wallet.findById(session.user.id)).balances.gems, 101);
});

test('returns which demo sign-in modes are available without disclosing the access code', async () => {
  const standard = await app.get('/api/auth/demo').expect(200);
  assert.deepEqual(standard.body, { success: true, publicDemo: true, evaluatorAccess: false });
  const evaluatorOnly = request(createApp({
    ...config, demo: false, evaluatorCode: randomBytes(24).toString('hex'),
  }));
  const reserved = await evaluatorOnly.get('/api/auth/demo').expect(200);
  assert.deepEqual(reserved.body, { success: true, publicDemo: false, evaluatorAccess: true });
});

test('reserves separate evaluator access when demo storage reaches public capacity', async () => {
  const accessCode = randomBytes(24).toString('hex');
  const instance = request(createApp({ ...config, evaluatorCode: accessCode }));
  await instance.post('/api/auth/demo/evaluator').send({ accessCode: 'wrong-code' }).expect(401);
  await User.insertMany(Array.from({ length: 1000 }, (_, i) => ({
    email: `capacity-test-${i}@veloop.test`, name: 'Capacity test', demo: true, demoAccess: 'public',
  })));
  await instance.post('/api/auth/demo').send({}).expect(503);
  const evaluator = await instance.post('/api/auth/demo/evaluator').send({ accessCode }).expect(201);
  assert.equal((await User.findById(evaluator.body.user.id)).demoAccess, 'evaluator');
  assert.equal((await wallet(evaluator.body)).ves, 25_000);
});
