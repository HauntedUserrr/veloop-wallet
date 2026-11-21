import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { authenticate, createDemoUser, login, requireAdmin, revokeSessions, sessionFor, verifyEvaluatorCode } from './auth.js';
import { fail, HttpError } from './errors.js';
import { adjustWallet, exchangeWallet, getTransactions, getWallet, getWalletSummary } from './services/wallet.js';
import { reconcileWallet } from './services/reconciliation.js';
import {
  abandonWithdrawalIntent, addOption, createWithdrawal, getWithdrawal, getWithdrawalReviewHistory, listOptions, listWithdrawals,
  prepareWithdrawal, reviewWithdrawal, updateMethod, updateOption,
} from './services/payout.js';
import * as input from './validators.js';
import { consumeBudget, limitLoginAttempts } from './request-budget.js';

function ipLimiter(limit, windowMs) {
  return rateLimit({
    limit, windowMs, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
      success: false, code: 'RATE_LIMITED', message: 'Too many requests. Try again later.',
    }),
  });
}

function userLimiter(scope, limit) {
  return async (req, res, next) => {
    await consumeBudget(res, `${scope}:${req.user._id}`, limit, 60_000);
    next();
  };
}

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet());

  app.get('/api/health', (_req, res) => {
    if (mongoose.connection.readyState !== 1) fail(503, 'DATABASE_UNAVAILABLE', 'Database unavailable.');
    res.json({ success: true, status: 'ready' });
  });

  const api = express.Router();
  app.use('/api', api);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use((req, _res, next) => {
    const origin = req.get('Origin');
    if (origin && !config.origins.includes(origin)) {
      fail(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.');
    }
    next();
  }, cors({ origin: config.origins }), express.json({ limit: '12kb', inflate: false }));
  const loginLimiter = ipLimiter(20, 15 * 60_000);
  const demoLimiter = ipLimiter(20, 15 * 60_000);
  const evaluatorLimiter = ipLimiter(20, 15 * 60_000);
  const payoutLimiter = userLimiter('withdrawal', 12);
  const mutationLimiter = userLimiter('admin-mutation', 60);
  const reportLimiter = userLimiter('admin-report', 30);

  api.post('/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = input.parse(input.credentials, req.body);
    await limitLoginAttempts(res, email, req.ip, config.jwtSecret);
    res.json({ success: true, ...sessionFor(await login(email, password), config) });
  });
  api.get('/auth/demo', (_req, res) => {
    res.json({ success: true, publicDemo: Boolean(config.demo), evaluatorAccess: Boolean(config.evaluatorCode) });
  });
  api.post('/auth/demo', demoLimiter, async (_req, res) => {
    if (!config.demo) fail(404, 'NOT_FOUND', 'Endpoint not found.');
    await consumeBudget(res, 'demo-provisioning', 120, 60 * 60_000);
    res.status(201).json({ success: true, ...sessionFor(await createDemoUser(), config) });
  });
  api.post('/auth/demo/evaluator', evaluatorLimiter, async (req, res) => {
    if (!config.evaluatorCode) fail(404, 'NOT_FOUND', 'Endpoint not found.');
    const { accessCode } = input.parse(input.evaluatorCredentials, req.body);
    if (!verifyEvaluatorCode(accessCode, config.evaluatorCode)) {
      fail(401, 'INVALID_EVALUATOR_CODE', 'The evaluator access code is incorrect.');
    }
    await consumeBudget(res, 'demo-evaluator-provisioning', 30, 60 * 60_000);
    res.status(201).json({ success: true, ...sessionFor(await createDemoUser('evaluator'), config) });
  });
  api.use(authenticate(config));
  api.post('/auth/logout', async (req, res) => {
    await revokeSessions(req.user);
    res.json({ success: true });
  });

  api.get('/wallet', async (req, res) => {
    if (Object.keys(req.query).length) fail(400, 'UNEXPECTED_QUERY', 'The wallet is selected by the authenticated session.');
    res.json({ success: true, wallet: await getWallet(req.user._id) });
  });
  api.get('/wallet/summary', async (req, res) => {
    const paging = input.parse(input.summaryPaging, req.query);
    res.json({ success: true, ...await getWalletSummary(req.user._id, paging) });
  });
  api.get('/wallet/transactions', async (req, res) => {
    const result = await getTransactions(req.user._id, input.parse(input.paging, req.query));
    res.json({ success: true, ...result });
  });
  for (const type of ['CREDIT', 'DEBIT']) {
    api.post(`/wallet/${type.toLowerCase()}`, requireAdmin, mutationLimiter, async (req, res) => {
      const entry = input.parse(input.adjustment(type), req.body);
      const transaction = await adjustWallet(req.user._id, type, entry);
      res.status(201).json({ success: true, transaction });
    });
  }
  api.post('/wallet/exchange', requireAdmin, mutationLimiter, async (req, res) => {
    const exchange = await exchangeWallet(req.user._id, input.parse(input.exchange, req.body));
    res.status(201).json({ success: true, ...exchange });
  });

  api.get('/payout/options', async (req, res) => {
    res.json({ success: true, methods: await listOptions(req.user) });
  });
  api.get('/payout/methods', async (req, res) => {
    const methods = await listOptions(req.user, undefined, { includeOptions: false });
    res.json({ success: true, methods });
  });
  api.get('/payout/options/:method', async (req, res) => {
    const [method] = await listOptions(req.user, input.parse(input.catalogId, req.params.method));
    res.json({ success: true, method });
  });

  api.post('/withdrawals/intents', userLimiter('withdrawal-intent', 12), async (req, res) => {
    const body = input.parse(input.withdrawalRequest, req.body);
    const key = input.parse(input.idempotency, req.get('Idempotency-Key'));
    const result = await prepareWithdrawal(req.user._id, body, key, config);
    res.json({ success: true, ...result });
  });
  api.delete('/withdrawals/intents', userLimiter('withdrawal-cancel-intent', 12), async (req, res) => {
    const key = input.parse(input.idempotency, req.get('Idempotency-Key'));
    const result = await abandonWithdrawalIntent(req.user._id, key);
    res.json({ success: true, ...result });
  });
  api.post('/withdrawals', payoutLimiter, async (req, res) => {
    const body = input.parse(input.withdrawalRequest, req.body);
    const key = input.parse(input.idempotency, req.get('Idempotency-Key'));
    const result = await createWithdrawal(req.user._id, body, key, config);
    res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
  });
  api.get('/withdrawals', async (req, res) => {
    const result = await listWithdrawals({ userId: req.user._id }, input.parse(input.paging, req.query));
    res.json({ success: true, ...result });
  });
  api.get('/withdrawals/attempt', async (req, res) => {
    const idempotencyKey = input.parse(input.idempotency, req.get('Idempotency-Key'));
    res.json({ success: true, withdrawal: await getWithdrawal({ idempotencyKey, userId: req.user._id }) });
  });
  api.get('/withdrawals/:id', async (req, res) => {
    const _id = input.parse(input.mongoId, req.params.id);
    res.json({ success: true, withdrawal: await getWithdrawal({ _id, userId: req.user._id }) });
  });

  const admin = express.Router();
  api.use('/admin', requireAdmin, admin);
  admin.get('/wallet/:userId/transactions', async (req, res) => {
    const userId = input.parse(input.mongoId, req.params.userId);
    const result = await getTransactions(userId, input.parse(input.paging, req.query));
    res.json({ success: true, ...result });
  });
  admin.get('/wallet/:userId/reconciliation', reportLimiter, async (req, res) => {
    const userId = input.parse(input.mongoId, req.params.userId);
    res.json({ success: true, reconciliation: await reconcileWallet(userId) });
  });
  admin.get('/withdrawals', async (req, res) => {
    const { status, userId, ...paging } = input.parse(input.withdrawalFilters, req.query);
    const filter = { ...(status && { status }), ...(userId && { userId }) };
    res.json({ success: true, ...await listWithdrawals(filter, paging) });
  });
  admin.get('/withdrawals/:id', async (req, res) => {
    const _id = input.parse(input.mongoId, req.params.id);
    res.json({ success: true, withdrawal: await getWithdrawal({ _id }) });
  });
  admin.get('/withdrawals/:id/audit', reportLimiter, async (req, res) => {
    const id = input.parse(input.mongoId, req.params.id);
    res.json({ success: true, history: await getWithdrawalReviewHistory(id) });
  });
  admin.patch('/withdrawals/:id', mutationLimiter, async (req, res) => {
    const id = input.parse(input.mongoId, req.params.id);
    const withdrawal = await reviewWithdrawal(req.user._id, id, input.parse(input.review, req.body));
    res.json({ success: true, withdrawal });
  });
  admin.patch('/payout/options/:id', mutationLimiter, async (req, res) => {
    const id = input.parse(input.catalogId, req.params.id);
    const option = await updateOption(req.user._id, id, input.parse(input.optionChanges, req.body));
    res.json({ success: true, option });
  });
  admin.post('/payout/options', mutationLimiter, async (req, res) => {
    const option = await addOption(req.user._id, input.parse(input.newOption, req.body));
    res.status(201).json({ success: true, option });
  });
  admin.patch('/payout/methods/:id', mutationLimiter, async (req, res) => {
    const id = input.parse(input.catalogId, req.params.id);
    const method = await updateMethod(req.user._id, id, input.parse(input.methodChanges, req.body));
    res.json({ success: true, method });
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    if (['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported'].includes(error.type)) {
      return res.status(error.status).json({ success: false, code: 'INVALID_BODY', message: 'Invalid or oversized JSON body.' });
    }
    console.error('Unhandled API error', { name: error.name, code: error.code });
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.' });
  });
  return app;
}
