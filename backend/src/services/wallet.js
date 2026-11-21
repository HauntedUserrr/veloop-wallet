import mongoose from 'mongoose';
import { AuditLog, Ledger, User, Wallet, Withdrawal, currencies } from '../models.js';
import { fail } from '../errors.js';
import { MAX_HISTORY_PAGE } from '../validators.js';

export function transact(work) {
  return mongoose.connection.transaction(work, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
}

export async function getWallet(userId, session = null) {
  const wallet = await Wallet.findById(userId).session(session).lean();
  if (!wallet) fail(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
  return { balances: wallet.balances, updatedAt: wallet.updatedAt };
}

export function getWalletSummary(userId, paging = { page: 1, limit: 5 }) {
  return transact(async session => {
    const wallet = await getWallet(userId, session);
    const { records, pagination } = await getTransactions(userId, paging, session);
    return { wallet, recentTransactions: records, pagination };
  });
}

export async function activeUser(userId, session) {
  const user = await User.findById(userId).session(session).lean();
  if (!user) fail(404, 'USER_NOT_FOUND', 'User not found.');
  if (user.status !== 'ACTIVE') fail(403, 'ACCOUNT_REVIEW', 'This account requires additional verification.');
  return user;
}

export async function activeAdministrator(userId, session) {
  const user = await activeUser(userId, session);
  if (user.role !== 'ADMIN') fail(403, 'FORBIDDEN', 'Administrator access required.');
}

export async function audit(event, session) {
  await AuditLog.create([event], { session });
}

async function checkRefundHeadroom(userId, currency, newBalance, session) {
  const [blocked] = await Withdrawal.aggregate([
    { $match: { userId, currency, status: { $in: ['PENDING', 'PROCESSING'] } } },
    { $group: { _id: null, liability: { $sum: { $toDecimal: '$currencyAmount' } } } },
    { $match: { liability: { $gt: Number.MAX_SAFE_INTEGER - newBalance } } },
  ]).session(session);
  if (blocked) fail(409, 'BALANCE_LIMIT', 'The balance would leave insufficient room for pending refunds.');
}

export async function postEntry(entry, actorId, session) {
  const { userId, currency, type, amount } = entry;
  if (!session?.inTransaction() || !currencies.includes(currency)
    || (type !== 'DEBIT' && type !== 'CREDIT') || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Invalid wallet journal operation.');
  }
  const path = `balances.${currency}`;
  const debit = type === 'DEBIT';
  const delta = debit ? -amount : amount;
  const limit = debit ? { $gte: amount } : { $lte: Number.MAX_SAFE_INTEGER - amount };
  const before = await Wallet.findOneAndUpdate(
    { _id: userId, [path]: limit },
    { $inc: { [path]: delta } },
    { session, returnDocument: 'before' },
  ).lean();

  if (!before) {
    if (!await Wallet.exists({ _id: userId }).session(session)) {
      fail(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
    }
    if (debit) fail(409, 'INSUFFICIENT_BALANCE', `Insufficient ${currency.toUpperCase()} balance.`);
    fail(409, 'BALANCE_LIMIT', 'The balance would exceed its supported limit.');
  }

  const balanceBefore = before.balances[currency];
  const balanceAfter = balanceBefore + delta;
  if (!debit && entry.source !== 'WITHDRAWAL_REVERSAL') {
    // The wallet write serializes credits with concurrent withdrawal creation and refunds.
    await checkRefundHeadroom(before._id, currency, balanceAfter, session);
  }
  const [transaction] = await Ledger.create([{
    ...entry, balanceBefore, balanceAfter,
  }], { session });
  await audit({
    actorId, targetUserId: userId,
    action: entry.source === 'CORRECTION' ? 'BALANCE_CORRECTION' : `WALLET_${type}`,
    targetType: 'WALLET_TRANSACTION', referenceId: String(transaction._id),
    metadata: { currency, amount, source: entry.source, referenceId: entry.referenceId },
  }, session);
  return transaction;
}

export async function adjustWallet(actorId, type, entry) {
  try {
    return await transact(async session => {
      await activeAdministrator(actorId, session);
      if (!await User.exists({ _id: entry.userId }).session(session)) {
        fail(404, 'USER_NOT_FOUND', 'User not found.');
      }
      return postEntry({ ...entry, type }, actorId, session);
    });
  } catch (error) {
    if (error.code === 11000) fail(409, 'DUPLICATE_REFERENCE', 'This wallet adjustment was already posted.');
    throw error;
  }
}

export async function exchangeWallet(actorId, entry) {
  try {
    return await transact(async session => {
      await activeAdministrator(actorId, session);
      await activeUser(entry.userId, session);
      const common = {
        userId: entry.userId, referenceId: entry.referenceId, description: entry.description,
      };
      if (await Ledger.exists({
        userId: entry.userId, referenceId: entry.referenceId, source: 'EXCHANGE_DEBIT',
      }).session(session)) {
        fail(409, 'DUPLICATE_REFERENCE', 'This exchange was already posted.');
      }
      const debit = await postEntry({
        ...common, type: 'DEBIT', source: 'EXCHANGE_DEBIT', currency: entry.fromCurrency, amount: entry.fromAmount,
      }, actorId, session);
      const credit = await postEntry({
        ...common, type: 'CREDIT', source: 'EXCHANGE_CREDIT', currency: entry.toCurrency, amount: entry.toAmount,
      }, actorId, session);
      return { debit, credit };
    });
  } catch (error) {
    if (error.code === 11000) fail(409, 'DUPLICATE_REFERENCE', 'This exchange was already posted.');
    throw error;
  }
}

export async function paginate(query, sort, { page, limit }) {
  const canAdvance = page < MAX_HISTORY_PAGE;
  const records = await query.sort(sort).skip((page - 1) * limit).limit(canAdvance ? limit + 1 : limit).lean();
  return { records: records.slice(0, limit), pagination: { page, limit, hasMore: canAdvance && records.length > limit } };
}

export function getTransactions(userId, paging, session = null) {
  return paginate(Ledger.find({ userId }).session(session), { createdAt: -1, _id: -1 }, paging);
}
