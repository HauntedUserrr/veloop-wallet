import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, Wallet, Withdrawal } from './models.js';
import { PayoutError, payoutOptions, reviewWithdrawal, submitWithdrawal, withdrawalView } from './payout.js';
import { adjustWallet } from './adjustment.js';
import { createDemoWallet, listTransactions, listWithdrawals, walletSnapshot } from './wallet.js';

const issuer = 'veloop-wallet';
const audience = 'wallet-api';
const reviewerAudience = 'wallet-review';

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
  return req.get('Authorization')?.match(/^Bearer ([^\s]{1,2048})$/i)?.[1];
}

function pageQuery(req, extra = []) {
  const page = readInteger(req.query.page, 1, 500);
  const limit = readInteger(req.query.limit, 20, 50);
  if (!page || !limit || Object.keys(req.query).some(key => !['page', 'limit', ...extra].includes(key))) return null;
  return { page, limit };
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
        res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

  app.get('/api/wallet/snapshot', async (req, res) => {
    const query = pageQuery(req);
    if (!query) return errorResponse(res, 422, 'Use page 1–500 and limit 1–50.');
    res.json(await walletSnapshot(req.userId, query.page, query.limit));
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
    res.json(await listWithdrawals({ userId: req.userId }, page, limit));
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
  const reviewerDigest = reviewerToken && createHash('sha256').update(reviewerToken).digest();
  const matchesReviewerToken = token => token && timingSafeEqual(createHash('sha256').update(token).digest(), reviewerDigest);
  const reviewLimit = rateLimit({
    limit: 120, windowMs: 60_000, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? ''),
    handler: (_req, res) => errorResponse(res, 429, 'Too many reviewer requests. Try again shortly.'),
  });
  const loginLimit = rateLimit({
    limit: 8, windowMs: 15 * 60_000, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? ''),
    skipSuccessfulRequests: true,
    handler: (_req, res) => errorResponse(res, 429, 'Too many sign-in attempts. Try again later.'),
  });
  app.post('/api/admin/session', loginLimit, (req, res) => {
    if (!reviewerDigest) return errorResponse(res, 404, 'Endpoint not found.');
    if (!matchesReviewerToken(bearer(req))) return errorResponse(res, 403, 'Reviewer access required.');
    const token = jwt.sign({}, reviewerDigest, {
      subject: 'review-service', algorithm: 'HS256', issuer, audience: reviewerAudience, expiresIn: '20m',
    });
    res.json({ token });
  });
  app.use('/api/admin', (req, res, next) => {
    if (!reviewerDigest) return errorResponse(res, 404, 'Endpoint not found.');
    const token = bearer(req);
    if (matchesReviewerToken(token)) return next();
    try {
      jwt.verify(token, reviewerDigest, {
        algorithms: ['HS256'], issuer, audience: reviewerAudience, subject: 'review-service',
      });
    } catch {
      return errorResponse(res, 403, 'Reviewer access required.');
    }
    next();
  });

  app.get('/api/admin/withdrawals', reviewLimit, async (req, res) => {
    const query = pageQuery(req, ['status']);
    const { status } = req.query;
    if (!query || (status !== undefined && !['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status))) {
      return errorResponse(res, 422, 'Provide a valid status and pagination.');
    }
    res.json(await listWithdrawals(status ? { status } : {}, query.page, query.limit, null, true));
  });

  app.get('/api/admin/transactions', reviewLimit, async (req, res) => {
    const query = pageQuery(req, ['userId']);
    const { userId } = req.query;
    if (!query || (userId !== undefined && (typeof userId !== 'string' || !mongoose.isObjectIdOrHexString(userId)))) {
      return errorResponse(res, 422, 'Provide a valid wallet ID and pagination.');
    }
    res.json(await listTransactions(userId, query.page, query.limit));
  });

  app.post('/api/admin/wallet/:userId/adjustments', reviewLimit, json, async (req, res) => {
    if (!mongoose.isObjectIdOrHexString(req.params.userId)) return errorResponse(res, 404, 'Wallet not found.');
    const result = await adjustWallet(req.params.userId, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.patch('/api/admin/withdrawals/:id', reviewLimit, json, async (req, res) => {
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
