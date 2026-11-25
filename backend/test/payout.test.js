import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase, Ledger, PayoutOption, Wallet, Withdrawal, WithdrawalEvent } from '../src/models.js';
import { seedPayoutOptions } from '../src/payout.js';

const payoutKey = randomBytes(32);
const reviewerToken = randomBytes(32).toString('hex');
const api = request(createApp({ jwtSecret: randomBytes(32).toString('hex'), payoutKey, reviewerToken, demoEnabled: true }));
const details = { optionId: 'upi_100', upiId: 'review@sample', quotedCost: 19500 };
let mongo;

before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '8.0.12' }, replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await connectDatabase(mongo.getUri('payout_tests'));
  await seedPayoutOptions();
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function demo() {
  return (await api.post('/api/auth/demo').expect(201)).body;
}

function submit(session, body = details, key = randomUUID()) {
  return api.post('/api/withdrawals').auth(session.token, { type: 'bearer' })
    .set('Idempotency-Key', key).send(body);
}

async function balance(session) {
  return (await Wallet.findById(session.user.id).lean()).balances.ves;
}

test('uses the database catalog for available options and preserves configured values on reseed', async () => {
  const session = await demo();
  await api.get('/api/payout/options').expect(401);
  await PayoutOption.updateOne({ _id: 'upi_10' }, { cost: 2500, active: false });
  try {
    await seedPayoutOptions();
    const { body } = await api.get('/api/payout/options').auth(session.token, { type: 'bearer' }).expect(200);
    assert.equal(body.options.length, 7);
    assert.equal(body.options.find(option => option.id === 'upi_100').cost, 19500);
    assert.equal((await PayoutOption.findById('upi_10')).cost, 2500);
    await submit(session, { optionId: 'upi_10', upiId: details.upiId }).expect(422);
  } finally {
    await PayoutOption.updateOne({ _id: 'upi_10' }, { cost: 2400, active: true });
  }
});

test('creates the pending withdrawal, linked debit and new balance together', async () => {
  const session = await demo();
  const { body: { withdrawal } } = await submit(session).expect(201);
  assert.equal(withdrawal.status, 'PENDING');
  assert.equal(withdrawal.amountPaise, 10000);
  assert.equal(await balance(session), 5500);
  const entry = await Ledger.findById(withdrawal.ledgerId);
  assert.deepEqual([entry.type, entry.amount, entry.balanceBefore, entry.balanceAfter], ['DEBIT', 19500, 25000, 5500]);
  assert.equal(String(entry.withdrawalId), withdrawal.id);
  assert.equal(withdrawal.encryptedDestination, undefined);
  const dbRecord = await Withdrawal.findById(withdrawal.id).select('+encryptedDestination');
  const [iv, tag, ciphertext] = dbRecord.encryptedDestination.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', payoutKey, iv);
  decipher.setAAD(Buffer.from(withdrawal.id));
  decipher.setAuthTag(tag);
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(), details.upiId);
});

test('deducts once for concurrent retries and rejects changed details under the same key', async () => {
  const session = await demo();
  const key = randomUUID();
  const responses = await Promise.all([submit(session, details, key), submit(session, details, key)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  assert.equal(responses[0].body.withdrawal.id, responses[1].body.withdrawal.id);
  await submit(session, { ...details, upiId: 'different@sample' }, key).expect(409);
  assert.equal(await balance(session), 5500);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, type: 'DEBIT' }), 1);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 1);
});

test('prevents overspending from separate concurrent withdrawals', async () => {
  const session = await demo();
  const responses = await Promise.all([submit(session), submit(session)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(responses.find(response => response.status === 409).body.code, 'INSUFFICIENT_BALANCE');
  assert.equal(await balance(session), 5500);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, type: 'DEBIT' }), 1);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 1);
});

test('rejects overridden prices, stale quotes, invalid destinations and missing keys', async () => {
  const session = await demo();
  await submit(session, { ...details, amount: 1 }).expect(422);
  const changed = await submit(session, { ...details, quotedCost: 1 }).expect(409);
  assert.equal(changed.body.code, 'QUOTE_CHANGED');
  await submit(session, { ...details, upiId: 'bad' }).expect(422);
  await api.post('/api/withdrawals').auth(session.token, { type: 'bearer' }).send(details).expect(422);
  await api.post('/api/withdrawals').auth(session.token, { type: 'bearer' })
    .set('Content-Type', 'application/json').send('{').expect(400);
  assert.equal(await balance(session), 25000);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 0);
});

test('requires reviewer access and refunds a rejected withdrawal exactly once', async () => {
  const session = await demo();
  const { body: { withdrawal } } = await submit(session).expect(201);
  const route = `/api/admin/withdrawals/${withdrawal.id}`;
  const decision = { status: 'REJECTED', reason: 'Demo review' };
  await api.patch(route).auth(session.token, { type: 'bearer' }).send(decision).expect(403);
  const reject = () => api.patch(route).auth(reviewerToken, { type: 'bearer' }).send(decision).expect(200);
  const [first, second] = await Promise.all([reject(), reject()]);
  assert.equal(first.body.withdrawal.status, 'REJECTED');
  assert.equal(first.body.withdrawal.refundLedgerId, second.body.withdrawal.refundLedgerId);
  assert.equal(await balance(session), 25000);
  assert.equal(await Ledger.countDocuments({ withdrawalId: withdrawal.id, type: 'CREDIT' }), 1);
  assert.equal(await WithdrawalEvent.countDocuments({ withdrawalId: withdrawal.id, to: 'REJECTED' }), 1);
});

test('approves a processing withdrawal without returning the debit', async () => {
  const session = await demo();
  const { body: { withdrawal } } = await submit(session).expect(201);
  const review = status => api.patch(`/api/admin/withdrawals/${withdrawal.id}`)
    .auth(reviewerToken, { type: 'bearer' }).send({ status });
  await review('APPROVED').expect(409);
  await review('PROCESSING').expect(200);
  const result = await review('APPROVED').expect(200);
  assert.equal(result.body.withdrawal.status, 'APPROVED');
  assert.equal(await balance(session), 5500);
  assert.equal(await Ledger.countDocuments({ withdrawalId: withdrawal.id, type: 'CREDIT' }), 0);
});

test('keeps withdrawal records and their destinations private', async () => {
  const owner = await demo();
  const outsider = await demo();
  const { body: { withdrawal } } = await submit(owner).expect(201);
  const route = `/api/withdrawals/${withdrawal.id}`;
  await api.get(route).auth(outsider.token, { type: 'bearer' }).expect(404);
  const history = await api.get('/api/withdrawals').auth(outsider.token, { type: 'bearer' }).expect(200);
  assert.deepEqual(history.body.records, []);
  const record = await api.get(route).auth(owner.token, { type: 'bearer' }).expect(200);
  assert.equal(record.body.withdrawal.encryptedDestination, undefined);
  assert.equal(record.body.withdrawal.requestFingerprint, undefined);
  assert.equal(record.body.withdrawal.idempotencyKey, undefined);
});

test('rolls back the balance and ledger when saving the pending request fails', async () => {
  const session = await demo();
  const original = Withdrawal.create;
  Withdrawal.create = async () => { throw new Error('Simulated write failure'); };
  try {
    await submit(session).expect(500);
  } finally {
    Withdrawal.create = original;
  }
  assert.equal(await balance(session), 25000);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, type: 'DEBIT' }), 0);
  assert.equal(await Withdrawal.countDocuments({ userId: session.user.id }), 0);
});

test('checks both quote values and recovers the original receipt by key', async () => {
  const session = (await request(createApp({
    jwtSecret: payoutKey.toString('hex'), payoutKey, demoEnabled: true,
  })).post('/api/auth/demo').expect(201)).body;
  const instance = request(createApp({ jwtSecret: payoutKey.toString('hex'), payoutKey }));
  const key = randomUUID();
  const send = quotedAmountPaise => instance.post('/api/withdrawals')
    .auth(session.token, { type: 'bearer' }).set('Idempotency-Key', key)
    .send({ ...details, quotedAmountPaise });
  const rejected = await send(5000).expect(409);
  assert.equal(rejected.body.code, 'QUOTE_CHANGED');
  assert.equal(await balance(session), 25000);

  const committed = await send(10000).expect(201);
  const receipt = await instance.get('/api/withdrawals/attempt')
    .auth(session.token, { type: 'bearer' }).set('Idempotency-Key', key).expect(200);
  assert.equal(receipt.body.withdrawal.id, committed.body.withdrawal.id);
  await send(10000).expect(200);
  assert.equal(await balance(session), 5500);
});

test('restricts adjustments to the reviewer and records a credit and debit once', async () => {
  const instance = request(createApp({
    jwtSecret: payoutKey.toString('hex'), payoutKey, reviewerToken, demoEnabled: true,
  }));
  const session = (await instance.post('/api/auth/demo').expect(201)).body;
  const adjust = token => instance.post('/api/admin/wallet/' + session.user.id + '/adjustments')
    .auth(token, { type: 'bearer' });
  const entry = { adjustmentId: 'test-adjustment-1', type: 'CREDIT', currency: 'ves', amount: 500, description: 'Test credit' };
  await adjust(session.token).send(entry).expect(403);
  await adjust(reviewerToken).send(entry).expect(201);
  await adjust(reviewerToken).send(entry).expect(200);
  assert.equal(await balance(session), 25500);
  await adjust(reviewerToken).send({ ...entry, amount: 1000 }).expect(409);
  await adjust(reviewerToken).send({
    ...entry, adjustmentId: 'test-adjustment-2', type: 'DEBIT', description: 'Test debit',
  }).expect(201);
  assert.equal(await balance(session), 25000);
  assert.equal(await Ledger.countDocuments({ userId: session.user.id, actor: 'review-service' }), 2);
});

test('returns CORS headers only for the configured frontend', async () => {
  const origin = 'https://wallet.example';
  const instance = request(createApp({ jwtSecret: reviewerToken, payoutKey, clientOrigin: origin }));
  const allowed = await instance.options('/api/withdrawals').set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST').expect(204);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  const other = await instance.get('/api/health').set('Origin', 'https://other.example').expect(200);
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  const review = await instance.options('/api/admin/withdrawals/example').set('Origin', origin)
    .set('Access-Control-Request-Method', 'PATCH').expect(204);
  assert.match(review.headers['access-control-allow-methods'], /PATCH/);
});

test('reviewer sessions authorize dashboard reads and an atomic refund without exposing UPI data', async () => {
  const instance = request(createApp({
    jwtSecret: reviewerToken, payoutKey, reviewerToken, demoEnabled: true,
  }));
  const { body: owner } = await instance.post('/api/auth/demo').expect(201);
  const { body: other } = await instance.post('/api/auth/demo').expect(201);
  const ownerAuth = route => route.auth(owner.token, { type: 'bearer' });
  const snapshot = () => ownerAuth(instance.get('/api/wallet/snapshot')).expect(200);

  await ownerAuth(instance.post('/api/admin/session')).expect(403);
  await ownerAuth(instance.get('/api/admin/withdrawals')).expect(403);
  const { body: reviewer } = await instance.post('/api/admin/session').auth(reviewerToken, { type: 'bearer' }).expect(200);
  const reviewerAuth = route => route.auth(reviewer.token, { type: 'bearer' });
  await reviewerAuth(instance.get('/api/wallet/snapshot')).expect(401);

  const { body: { withdrawal } } = await ownerAuth(instance.post('/api/withdrawals'))
    .set('Idempotency-Key', randomUUID()).send(details).expect(201);
  const { body: { records } } = await reviewerAuth(instance.get('/api/admin/withdrawals?status=PENDING&limit=50')).expect(200);
  const queued = records.find(item => item.id === withdrawal.id);
  assert.equal(queued.userId, owner.user.id);
  assert.equal(queued.encryptedDestination, undefined);
  assert.equal(queued.upiId, undefined);
  assert.equal(queued.requestFingerprint, undefined);
  await instance.get('/api/withdrawals/' + withdrawal.id).auth(other.token, { type: 'bearer' }).expect(404);

  const pending = (await snapshot()).body;
  assert.equal(pending.wallet.balances.ves, 5500);
  assert.equal(pending.history.records.find(entry => entry._id === withdrawal.ledgerId).status, 'PENDING');
  const { body: pendingMonitor } = await reviewerAuth(instance.get('/api/admin/transactions')
    .query({ userId: owner.user.id })).expect(200);
  assert.equal(pendingMonitor.records.find(entry => entry._id === withdrawal.ledgerId).status, 'PENDING');
  await reviewerAuth(instance.patch('/api/admin/withdrawals/' + withdrawal.id))
    .send({ status: 'PROCESSING', reason: { unexpected: true } }).expect(422);
  const reject = () => reviewerAuth(instance.patch('/api/admin/withdrawals/' + withdrawal.id))
    .send({ status: 'REJECTED', reason: 'Demo refund' }).expect(200);
  const outcomes = await Promise.all([reject(), reject()]);
  assert.equal(outcomes[0].body.withdrawal.refundLedgerId, outcomes[1].body.withdrawal.refundLedgerId);

  const refunded = (await snapshot()).body;
  assert.equal(refunded.wallet.balances.ves, 25000);
  assert.equal(refunded.withdrawals.records[0].status, 'REJECTED');
  assert.equal(refunded.history.records.find(entry => entry._id === withdrawal.ledgerId).status, 'REJECTED');
  assert.equal(refunded.history.records.filter(entry => entry.source === 'WITHDRAWAL_REVERSAL').length, 1);
  const { body: monitor } = await reviewerAuth(instance.get('/api/admin/transactions').query({ userId: owner.user.id })).expect(200);
  assert.ok(monitor.records.every(entry => entry.userId === owner.user.id));
  assert.equal(monitor.records.find(entry => entry._id === withdrawal.ledgerId).status, 'REJECTED');
  assert.equal(monitor.records.find(entry => entry.source === 'WITHDRAWAL_REVERSAL').status, 'POSTED');
  const { body: history } = await ownerAuth(instance.get('/api/wallet/transactions')).expect(200);
  assert.equal(history.records.find(entry => entry._id === withdrawal.ledgerId).status, 'REJECTED');
});
