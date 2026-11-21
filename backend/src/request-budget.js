import { createHmac } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { RequestBudget } from './models.js';
import { fail } from './errors.js';

const loginWindowMs = 15 * 60_000;

function hashedBudgetKey(scope, fields, secret) {
  const digest = createHmac('sha256', secret).update(JSON.stringify([scope, ...fields])).digest('hex');
  return `${scope}:${digest}`;
}

export async function limitLoginAttempts(res, email, clientIp, secret) {
  const source = ipKeyGenerator(clientIp);
  await consumeBudget(res, hashedBudgetKey('login-source', [source], secret), 20, loginWindowMs);
  await consumeBudget(res, hashedBudgetKey('login-account-source', [source, email], secret), 12, loginWindowMs);
}

export async function consumeBudget(res, key, limit, windowMs) {
  const now = Date.now();
  const window = Math.floor(now / windowMs);
  const reset = (window + 1) * windowMs;
  const filter = { _id: `${key}:${window}` };
  const update = { $inc: { hits: 1 }, $setOnInsert: { expiresAt: new Date(reset) } };
  const options = { upsert: true, returnDocument: 'after', projection: { hits: 1 } };
  let bucket;
  try {
    bucket = await RequestBudget.findOneAndUpdate(filter, update, options).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    bucket = await RequestBudget.findOneAndUpdate(filter, update, { ...options, upsert: false }).lean();
  }
  if (!bucket || bucket.hits > limit) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))));
    fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
}
