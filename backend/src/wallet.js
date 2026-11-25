import mongoose from 'mongoose';
import { currencies, Ledger, User, Wallet, Withdrawal } from './models.js';
import { PayoutError, withdrawalView } from './payout.js';

const openingCredits = [
  ['ves', 22_800, 'BONUS', 'Opening demo credits'],
  ['ves', 500, 'AD_REWARD', 'Ad reward'],
  ['ves', 200, 'DAILY_REWARD', 'Daily reward'],
  ['ves', 1500, 'REFERRAL', 'Referral reward'],
  ['sves', 5000, 'BONUS', 'Opening SVEs'],
  ['gems', 100, 'BONUS', 'Opening gems'],
  ['tokens', 500, 'BONUS', 'Opening tokens'],
  ['spins', 3, 'BONUS', 'Opening spins'],
];

export function createDemoWallet() {
  return mongoose.connection.transaction(async session => {
    const [user] = await User.create([{ name: 'Demo user', demo: true }], { session });
    const balances = Object.fromEntries(currencies.map(currency => [currency, 0]));
    const entries = openingCredits.map(([currency, amount, source, description]) => {
      const balanceBefore = balances[currency];
      balances[currency] += amount;
      return {
        userId: user._id, currency, amount, source, description,
        type: 'CREDIT', balanceBefore, balanceAfter: balances[currency],
      };
    });

    await Wallet.create([{ _id: user._id, balances }], { session });
    await Ledger.insertMany(entries, { session });
    return { id: String(user._id), name: user.name };
  }, { writeConcern: { w: 'majority' } });
}

export async function listTransactions(userId, page, limit, session = null) {
  const records = await Ledger.find(userId ? { userId } : {})
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit + 1)
    .session(session).lean();
  return { records: records.slice(0, limit), page, limit, hasMore: page < 500 && records.length > limit };
}

export async function listWithdrawals(filter, page, limit, session = null, admin = false) {
  const records = await Withdrawal.find(filter).sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit).limit(limit + 1).session(session).lean();
  return {
    records: records.slice(0, limit).map(record => ({
      ...withdrawalView(record),
      ...(admin && { userId: String(record.userId) }),
    })),
    page, limit, hasMore: page < 500 && records.length > limit,
  };
}

export function walletSnapshot(userId, page, limit) {
  return mongoose.connection.transaction(async session => {
    const wallet = await Wallet.findById(userId).select('balances updatedAt -_id').session(session).lean();
    if (!wallet) throw new PayoutError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
    const history = await listTransactions(userId, page, limit, session);
    const withdrawals = await listWithdrawals({ userId }, 1, 20, session);
    const linkedIds = history.records.flatMap(entry => entry.withdrawalId ? [entry.withdrawalId] : []);
    const linked = await Withdrawal.find({ userId, _id: { $in: linkedIds } })
      .select('status').session(session).lean();
    const statuses = new Map(linked.map(record => [String(record._id), record.status]));
    for (const entry of history.records) {
      entry.status = entry.source === 'WITHDRAWAL' ? statuses.get(String(entry.withdrawalId)) ?? 'POSTED' : 'POSTED';
    }
    return { wallet, history, withdrawals };
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
}
