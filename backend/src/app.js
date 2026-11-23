import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, Wallet } from './models.js';
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

export function createApp({ jwtSecret, demoEnabled = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
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

  app.use('/api/wallet', async (req, res, next) => {
    const token = req.get('Authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    let userId;
    try {
      userId = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer, audience }).sub;
    } catch {
      return errorResponse(res, 401, 'Sign in to view your wallet.');
    }
    if (!mongoose.isObjectIdOrHexString(userId) || !await User.exists({ _id: userId })) {
      return errorResponse(res, 401, 'Sign in to view your wallet.');
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

  app.use((_req, res) => errorResponse(res, 404, 'Endpoint not found.'));
  app.use((error, _req, res, _next) => {
    console.error('API request failed', error.name, error.code);
    errorResponse(res, 500, 'Wallet request failed.');
  });
  return app;
}
