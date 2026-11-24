import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, Wallet, Withdrawal } from './models.js';
import { PayoutError, payoutOptions, reviewWithdrawal, submitWithdrawal, withdrawalView } from './payout.js';
import { adjustWallet } from './adjustment.js';
import { createDemoWallet, listTransactions } from './wallet.js';

const issuer = 'veloop-wallet';
const audience = 'wallet-api';

function errorResponse(res, status, message) {
  return res.status(status).json({ error: message });
}

function readInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= 1 && number <= max ? number : null;
}

function bearer(req) {
  return req.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
}

export function createApp({ jwtSecret, payoutKey, reviewerToken, demoEnabled = false, clientOrigin, trustProxy = 0 }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    res.vary('Origin');
    if (clientOrigin && origin === clientOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
        return res.sendStatus(204);
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    if (mongoose.connection.readyState !== 1) return errorResponse(res, 503, 'Database unavailable.');
    res.json({ status: 'ready' });
  });

  const demoLimit = rateLimit({
    limit: 10, windowMs: 15 * 60_000, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => errorResponse(res, 429, 'Too many demo requests. Try again later.'),
  });

  app.post('/api/auth/demo', demoLimit, async (_req, res) => {
    if (!demoEnabled) return errorResponse(res, 404, 'Demo sign-in is disabled.');
    const user = await createDemoWallet();
    const token = jwt.sign({}, jwtSecret, {
      subject: user.id, algorithm: 'HS256', issuer, audience, expiresIn: '2h',
    });
    res.status(201).json({ token, user });
  });

  app.use(['/api/wallet', '/api/payout', '/api/withdrawals'], async (req, res, next) => {
    const token = bearer(req);
    let userId;
    try {
      userId = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer, audience }).sub;
    } catch {
      return errorResponse(res, 401, 'Sign in to continue.');
    }
    if (!mongoose.isObjectIdOrHexString(userId) || !await User.exists({ _id: userId })) {
      return errorResponse(res, 401, 'Sign in to continue.');
    }
    req.userId = userId;
    next();
  });

  app.get('/api/wallet', async (req, res) => {
    if (Object.keys(req.query).length) return errorResponse(res, 400, 'This endpoint takes no query parameters.');
    const wallet = await Wallet.findById(req.userId).select('balances updatedAt -_id').lean();
    if (!wallet) return errorResponse(res, 404, 'Wallet not found.');
    res.json({ wallet });
  });

  app.get('/api/wallet/transactions', async (req, res) => {
    const page = readInteger(req.query.page, 1, 500);
    const limit = readInteger(req.query.limit, 20, 50);
    if (!page || !limit || Object.keys(req.query).some(key => key !== 'page' && key !== 'limit')) {
      return errorResponse(res, 422, 'Use page 1–500 and limit 1–50.');
    }
    res.json(await listTransactions(req.userId, page, limit));
  });

  app.get('/api/payout/options', async (_req, res) => {
    res.json({ options: await payoutOptions() });
  });

  const withdrawalLimit = rateLimit({
    limit: 12, windowMs: 60_000, keyGenerator: req => req.userId,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => errorResponse(res, 429, 'Too many withdrawal requests. Try again later.'),
  });

  app.post('/api/withdrawals', withdrawalLimit, express.json({ limit: '4kb', inflate: false }), async (req, res) => {
    const result = await submitWithdrawal(req.userId, req.body, req.get('Idempotency-Key'), payoutKey);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.get('/api/withdrawals', async (req, res) => {
    const page = readInteger(req.query.page, 1, 500);
    const limit = readInteger(req.query.limit, 20, 50);
    if (!page || !limit || Object.keys(req.query).some(key => key !== 'page' && key !== 'limit')) {
      return errorResponse(res, 422, 'Use page 1–500 and limit 1–50.');
    }
    const records = await Withdrawal.find({ userId: req.userId }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit + 1).lean();
    res.json({ records: records.slice(0, limit).map(withdrawalView), page, limit, hasMore: page < 500 && records.length > limit });
  });

  app.get('/api/withdrawals/attempt', async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || !/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey)) {
      return errorResponse(res, 422, 'Provide a valid Idempotency-Key.');
    }
    const withdrawal = await Withdrawal.findOne({ userId: req.userId, idempotencyKey }).lean();
    if (!withdrawal) return errorResponse(res, 404, 'Withdrawal not found.');
    res.json({ withdrawal: withdrawalView(withdrawal) });
  });

  app.get('/api/withdrawals/:id', async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return errorResponse(res, 404, 'Withdrawal not found.');
    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!withdrawal) return errorResponse(res, 404, 'Withdrawal not found.');
    res.json({ withdrawal: withdrawalView(withdrawal) });
  });

  const json = express.json({ limit: '4kb', inflate: false });
  app.use('/api/admin', (req, res, next) => {
    if (!reviewerToken) return errorResponse(res, 404, 'Endpoint not found.');
    const token = bearer(req);
    const digest = value => createHash('sha256').update(value).digest();
    if (!token || !timingSafeEqual(digest(token), digest(reviewerToken))) {
      return errorResponse(res, 403, 'Reviewer access required.');
    }
    next();
  });

  app.post('/api/admin/wallet/:userId/adjustments', json, async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.userId)) return errorResponse(res, 404, 'Wallet not found.');
    const result = await adjustWallet(req.params.userId, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.patch('/api/admin/withdrawals/:id', json, async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return errorResponse(res, 404, 'Withdrawal not found.');
    res.json({ withdrawal: await reviewWithdrawal(req.params.id, req.body) });
  });

  app.use((_req, res) => errorResponse(res, 404, 'Endpoint not found.'));
  app.use((error, _req, res, _next) => {
    if (error instanceof PayoutError) {
      return res.status(error.status).json({ code: error.code, error: error.message });
    }
    if (['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported'].includes(error.type)) {
      return errorResponse(res, error.status, 'Send a valid JSON request.');
    }
    console.error('API request failed', error.name, error.code);
    return errorResponse(res, 500, 'Wallet request failed.');
  });
  return app;
}
