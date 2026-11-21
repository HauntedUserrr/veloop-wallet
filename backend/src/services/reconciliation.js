import mongoose from 'mongoose';
import { currencies, Ledger } from '../models.js';
import { getWallet, transact } from './wallet.js';

export function reconcileWallet(userId) {
  return transact(async session => {
    const { balances } = await getWallet(userId, session);
    const totals = await Ledger.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), status: 'POSTED' } },
      {
        $project: {
          currency: 1,
          type: 1,
          // Amounts are safe integers. Convert through BSON Long to preserve every digit.
          amount: { $toDecimal: { $toLong: '$amount' } },
        },
      },
      {
        $group: {
          _id: '$currency',
          credits: { $sum: { $cond: [{ $eq: ['$type', 'CREDIT'] }, '$amount', 0] } },
          debits: { $sum: { $cond: [{ $eq: ['$type', 'DEBIT'] }, '$amount', 0] } },
          entries: { $sum: 1 },
        },
      },
    ]).session(session);
    const byCurrency = new Map(totals.map(total => [total._id, total]));
    const reconciled = Object.fromEntries(currencies.map(currency => {
      const total = byCurrency.get(currency);
      const credits = BigInt(total?.credits.toString() ?? '0');
      const debits = BigInt(total?.debits.toString() ?? '0');
      const expected = credits - debits;
      const actual = BigInt(balances[currency] ?? 0);
      return [currency, {
        credits: credits.toString(),
        debits: debits.toString(),
        entries: total?.entries ?? 0,
        expected: expected.toString(),
        actual: actual.toString(),
        difference: (actual - expected).toString(),
      }];
    }));
    return {
      userId: String(userId),
      balanced: Object.values(reconciled).every(currency => currency.difference === '0'),
      currencies: reconciled,
    };
  });
}
