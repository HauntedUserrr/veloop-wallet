import mongoose from 'mongoose';
import { currencies, Ledger, Wallet, Withdrawal } from './models.js';
import { PayoutError } from './payout.js';

export async function adjustWallet(userId, input) {
  const { adjustmentId, currency, type, amount, description } = input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => !['adjustmentId', 'currency', 'type', 'amount', 'description'].includes(field))
    || !/^[a-zA-Z0-9_-]{8,80}$/.test(typeof adjustmentId === 'string' ? adjustmentId : '')
    || !currencies.includes(currency) || !['CREDIT', 'DEBIT'].includes(type)
    || !Number.isSafeInteger(amount) || amount < 1
    || typeof description !== 'string' || !description.trim() || description.length > 200) {
    throw new PayoutError(422, 'INVALID_ADJUSTMENT', 'Provide an adjustment ID, currency, type, positive integer amount and description.');
  }

  const identity = { userId, adjustmentId };
  const path = 'balances.' + currency;
  const credit = type === 'CREDIT';
  const delta = credit ? amount : -amount;
  return mongoose.connection.transaction(async session => {
    const existing = await Ledger.findOne(identity).session(session).lean();
    if (existing) {
      if (existing.currency !== currency || existing.type !== type || existing.amount !== amount
        || existing.description !== description.trim()) {
        throw new PayoutError(409, 'ADJUSTMENT_CONFLICT', 'This adjustment ID already belongs to another entry.');
      }
      return { entry: existing, replayed: true };
    }

    const limit = credit ? { $lte: Number.MAX_SAFE_INTEGER - amount } : { $gte: amount };
    const previous = await Wallet.findOneAndUpdate({ _id: userId, [path]: limit },
      { $inc: { [path]: delta } }, { session, returnDocument: 'before' }).lean();
    if (!previous) {
      if (!await Wallet.exists({ _id: userId }).session(session)) {
        throw new PayoutError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
      }
      throw new PayoutError(409, 'BALANCE_LIMIT', 'The adjustment would take the balance outside its allowed range.');
    }

    const balanceBefore = previous.balances[currency];
    const balanceAfter = balanceBefore + delta;
    if (credit) {
      // Leave room to reverse withdrawals that have not reached a terminal state.
      const [open] = await Withdrawal.aggregate([
        { $match: { userId: previous._id, currency, status: { $in: ['PENDING', 'PROCESSING'] } } },
        { $group: { _id: null, total: { $sum: { $toDecimal: { $toLong: '$cost' } } } } },
      ]).session(session);
      if (open && BigInt(open.total.toString()) > BigInt(Number.MAX_SAFE_INTEGER - balanceAfter)) {
        throw new PayoutError(409, 'BALANCE_LIMIT', 'The adjustment would leave no room for pending refunds.');
      }
    }

    const [entry] = await Ledger.create([{
      ...identity, currency, type, amount, balanceBefore, balanceAfter,
      source: credit ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT', description: description.trim(), actor: 'review-service',
    }], { session });
    return { entry, replayed: false };
  }, { writeConcern: { w: 'majority' } });
}
