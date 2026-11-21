import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuditLog, Ledger, RequestBudget, User, Wallet, currencies } from './models.js';
import { fail } from './errors.js';
import { transact } from './services/wallet.js';

const scrypt = promisify(scryptCallback);
const issuer = 'veloop-wallet-api';
const audience = 'veloop-wallet-demo';
const fallbackPasswordHash = `${'00'.repeat(16)}:${'00'.repeat(64)}`;

export const administratorCredentials = z.object({
  email: z.email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(16).max(128).refine(value => value.trim() === value),
});

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function rotateAdminPassword(email, password) {
  const credentials = administratorCredentials.parse({ email, password });
  const passwordHash = await hashPassword(credentials.password);
  const result = await User.updateOne(
    { email: credentials.email, role: 'ADMIN', demo: { $ne: true } },
    { $set: { passwordHash }, $inc: { sessionVersion: 1 } },
    { writeConcern: { w: 'majority' } },
  );
  if (!result.matchedCount) fail(404, 'ADMIN_NOT_FOUND', 'Administrator account not found.');
}

export async function login(email, password) {
  const user = await User.findOne({ email }).select('+passwordHash +sessionVersion');
  const [salt, hash] = (user?.passwordHash ?? fallbackPasswordHash).split(':');
  const actual = await scrypt(password, salt, 64);
  if (!timingSafeEqual(actual, Buffer.from(hash, 'hex')) || !user?.passwordHash) {
    fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.status === 'SUSPENDED') fail(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  return user;
}

export function verifyEvaluatorCode(providedCode, expectedCode) {
  if (typeof providedCode !== 'string' || !expectedCode) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(providedCode), digest(expectedCode));
}

export async function createDemoUser(access = 'public') {
  if (access !== 'public' && access !== 'evaluator') throw new Error('Invalid demo access type.');
  const poolId = `demo-capacity:${access}`;
  const capacity = access === 'public' ? 1000 : 200;
  const pool = { demo: true, demoAccess: access === 'public' ? { $in: ['public', null] } : access };

  const provision = () => transact(async session => {
    // Serializes admission within one pool. The capacity check and all demo rows commit together.
    await RequestBudget.updateOne({ _id: poolId }, { $inc: { hits: 1 } }, { upsert: true, session });
    if (await User.countDocuments(pool).limit(capacity).session(session) >= capacity) {
      fail(503, 'DEMO_CAPACITY', 'All demo slots are currently in use. Try again later.');
    }
    const [user] = await User.create([{
      email: `demo-${randomUUID()}@veloop.test`, name: 'Demo user',
      demo: true, demoAccess: access, verified: true,
    }], { session });
    const balances = Object.fromEntries(currencies.map(currency => [currency, 0]));
    const rewards = [
      ['ves', 22800, 'BONUS', 'Demo starting reward'],
      ['ves', 500, 'AD_REWARD', 'Watch ad reward'],
      ['ves', 200, 'DAILY_REWARD', 'Daily reward'],
      ['ves', 1500, 'REFERRAL', 'Referral reward'],
      ['sves', 5000, 'BONUS', 'Demo SVE balance'],
      ['gems', 100, 'BONUS', 'Demo Gems balance'],
      ['tokens', 500, 'BONUS', 'Demo Tokens balance'],
      ['spins', 3, 'BONUS', 'Demo Spins balance'],
    ];
    const entries = rewards.map(([currency, amount, source, description], index) => {
      const balanceBefore = balances[currency];
      balances[currency] += amount;
      return {
        userId: user._id, type: 'CREDIT', currency, amount, source,
        balanceBefore, balanceAfter: balances[currency],
        description, referenceId: `demo-seed-${index + 1}`,
      };
    });
    await Wallet.create([{ _id: user._id, balances }], { session });
    const journal = await Ledger.insertMany(entries, { session });
    await AuditLog.insertMany(journal.map(({ _id, currency, amount, source, referenceId }) => ({
      actorId: user._id, targetUserId: user._id, action: 'WALLET_CREDIT',
      targetType: 'WALLET_TRANSACTION', referenceId: String(_id),
      metadata: { currency, amount, source, referenceId },
    })), { session });
    return user;
  });
  try {
    return await provision();
  } catch (error) {
    // Concurrent first use may race to create the singleton. The losing write can now retry.
    if (error.code !== 11000 || error.keyValue?._id !== poolId) throw error;
    return provision();
  }
}

export function sessionFor(user, config) {
  const lifetime = user.role === 'ADMIN' ? 30 * 60 : 2 * 60 * 60;
  const token = jwt.sign({ version: user.sessionVersion ?? 0, role: user.role }, config.jwtSecret, {
    algorithm: 'HS256', subject: String(user._id), audience, issuer, expiresIn: lifetime,
  });
  return { token, user: { id: user._id, name: user.name, role: user.role, demo: user.demo } };
}

export function authenticate(config) {
  return async (req, _res, next) => {
    const token = req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    let claims;
    try {
      claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer, audience });
    } catch {
      fail(401, 'AUTH_REQUIRED', 'Session expired or invalid. Sign in again.');
    }
    if (typeof claims?.sub !== 'string' || !/^[a-f0-9]{24}$/.test(claims.sub)) {
      fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    }
    req.user = await User.findById(claims.sub)
      .select('role status verified region demo +sessionVersion').lean();
    // Tokens issued before versioning can only keep ordinary user access.
    const role = claims.role ?? 'USER';
    const version = claims.version ?? 0;
    if (!req.user || role !== req.user.role || version !== (req.user.sessionVersion ?? 0)) {
      fail(401, 'AUTH_REQUIRED', 'Session expired or invalid. Sign in again.');
    }
    if (req.user.status === 'SUSPENDED') fail(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    next();
  };
}

export async function revokeSessions(user) {
  const sessionVersion = user.sessionVersion ? user.sessionVersion : { $in: [null, 0] };
  await User.updateOne({ _id: user._id, sessionVersion }, { $inc: { sessionVersion: 1 } });
}

export function requireAdmin(req, _res, next) {
  if (req.user.role !== 'ADMIN' || req.user.status !== 'ACTIVE') {
    fail(403, 'FORBIDDEN', 'Administrator access required.');
  }
  next();
}
