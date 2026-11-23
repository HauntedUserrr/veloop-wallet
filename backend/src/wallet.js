import mongoose from 'mongoose';
import { currencies, Ledger, User, Wallet } from './models.js';

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

export async function listTransactions(userId, page, limit) {
  const records = await Ledger.find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit + 1)
    .lean();
  return { records: records.slice(0, limit), page, limit, hasMore: page < 500 && records.length > limit };
}
