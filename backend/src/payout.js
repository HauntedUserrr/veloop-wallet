import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { Ledger, PayoutOption, Wallet, Withdrawal, WithdrawalEvent } from './models.js';

export class PayoutError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const upiTiers = [
  [10, 2400], [25, 5800], [50, 10000], [100, 19500], [150, 28500],
  [300, 52500], [500, 80500], [1000, 150000],
];

export async function seedPayoutOptions() {
  await PayoutOption.bulkWrite(upiTiers.map(([rupees, cost]) => ({
    updateOne: {
      filter: { _id: `upi_${rupees}` },
      update: { $setOnInsert: { method: 'upi', currency: 'ves', cost, amountPaise: rupees * 100, active: true } },
      upsert: true,
    },
  })));
}

export async function payoutOptions() {
  const options = await PayoutOption.find({ active: true }).sort({ amountPaise: 1, _id: 1 }).lean();
  return options.map(({ _id, method, currency, cost, amountPaise }) => ({
    id: _id, method, currency, cost, amountPaise, destinationField: 'upiId',
  }));
}

function requestDetails(body, key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    throw new PayoutError(422, 'INVALID_IDEMPOTENCY_KEY', 'Provide an Idempotency-Key of 16 to 128 letters, digits, hyphens or underscores.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(field => !['optionId', 'upiId', 'quotedCost', 'quotedAmountPaise'].includes(field))
      || typeof body.optionId !== 'string' || !/^[a-z0-9_]{1,64}$/.test(body.optionId)
      || ['quotedCost', 'quotedAmountPaise'].some(field => body[field] !== undefined && (!Number.isSafeInteger(body[field]) || body[field] < 1))) {
    throw new PayoutError(422, 'INVALID_WITHDRAWAL', 'Provide optionId and upiId, with optional quote values.');
  }
  const upiId = typeof body.upiId === 'string' ? body.upiId.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{1,127}@[a-z0-9][a-z0-9.-]{1,63}$/.test(upiId)) {
    throw new PayoutError(422, 'INVALID_UPI_ID', 'Enter a UPI ID in the form name@provider.');
  }
  return { optionId: body.optionId, upiId, quotedCost: body.quotedCost, quotedAmountPaise: body.quotedAmountPaise };
}

function encryptDestination(upiId, key, id) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(id)));
  const ciphertext = Buffer.concat([cipher.update(upiId, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

export function withdrawalView(record) {
  const { _id, optionId, method, currency, cost, amountPaise, status, ledgerId,
    refundLedgerId, rejectionReason, createdAt, updatedAt } = record;
  return { id: String(_id), optionId, method, currency, cost, amountPaise, status,
    ledgerId: String(ledgerId), refundLedgerId, rejectionReason, createdAt, updatedAt };
}

function existingWithdrawal(record, fingerprint) {
  if (record.requestFingerprint !== fingerprint) {
    throw new PayoutError(409, 'IDEMPOTENCY_CONFLICT', 'This request key already belongs to another withdrawal.');
  }
  return { withdrawal: withdrawalView(record), replayed: true };
}

export async function submitWithdrawal(userId, body, idempotencyKey, encryptionKey) {
  const { optionId, upiId, quotedCost, quotedAmountPaise } = requestDetails(body, idempotencyKey);
  const quote = ['withdrawal', optionId, upiId, quotedCost ?? null];
  if (quotedAmountPaise !== undefined) quote.push(quotedAmountPaise);
  const fingerprint = createHmac('sha256', encryptionKey).update(JSON.stringify(quote)).digest('hex');
  const ownerAndKey = { userId, idempotencyKey };

  try {
    return await mongoose.connection.transaction(async session => {
      const previous = await Withdrawal.findOne(ownerAndKey).select('+requestFingerprint').session(session);
      if (previous) return existingWithdrawal(previous, fingerprint);

      const option = await PayoutOption.findOne({ _id: optionId, method: 'upi', active: true }).session(session);
      if (!option) throw new PayoutError(422, 'OPTION_UNAVAILABLE', 'This payout option is unavailable.');
      const { currency, cost, amountPaise, method } = option;
      if ((quotedCost !== undefined && quotedCost !== cost)
          || (quotedAmountPaise !== undefined && quotedAmountPaise !== amountPaise)) {
        throw new PayoutError(409, 'QUOTE_CHANGED', 'The payout quote changed. Refresh the catalog and review the amount.');
      }

      const balancePath = `balances.${currency}`;
      const before = await Wallet.findOneAndUpdate(
        { _id: userId, [balancePath]: { $gte: cost } },
        { $inc: { [balancePath]: -cost } },
        { session, returnDocument: 'before' },
      ).lean();
      if (!before) {
        if (!await Wallet.exists({ _id: userId }).session(session)) {
          throw new PayoutError(404, 'WALLET_NOT_FOUND', 'Wallet not found.');
        }
        throw new PayoutError(409, 'INSUFFICIENT_BALANCE', 'Your wallet has insufficient credits for this payout.');
      }

      const id = new mongoose.Types.ObjectId();
      const balanceBefore = before.balances[currency];
      const [entry] = await Ledger.create([{
        userId, withdrawalId: id, currency, type: 'DEBIT', amount: cost,
        balanceBefore, balanceAfter: balanceBefore - cost,
        source: 'WITHDRAWAL', description: 'UPI redemption',
      }], { session });
      const [withdrawal] = await Withdrawal.create([{
        _id: id, ...ownerAndKey, optionId, method, currency, cost, amountPaise,
        encryptedDestination: encryptDestination(upiId, encryptionKey, id),
        requestFingerprint: fingerprint, ledgerId: entry._id, status: 'PENDING',
      }], { session });
      await WithdrawalEvent.create([{ withdrawalId: id, actor: userId, to: 'PENDING' }], { session });
      return { withdrawal: withdrawalView(withdrawal), replayed: false };
    }, { writeConcern: { w: 'majority' } });
  } catch (error) {
    if (error.code === 11000) {
      const previous = await Withdrawal.findOne(ownerAndKey).select('+requestFingerprint');
      if (previous) return existingWithdrawal(previous, fingerprint);
    }
    throw error;
  }
}

const reviewTransitions = {
  PENDING: ['PROCESSING', 'REJECTED', 'CANCELLED'],
  PROCESSING: ['APPROVED', 'REJECTED', 'CANCELLED'],
};

export async function reviewWithdrawal(id, body) {
  const { status, reason } = body ?? {};
  const refund = status === 'REJECTED' || status === 'CANCELLED';
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(field => !['status', 'reason'].includes(field))
      || !['PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status)
      || (refund && (typeof reason !== 'string' || !reason.trim() || reason.length > 200))) {
    throw new PayoutError(422, 'INVALID_REVIEW', 'Provide a valid status and a reason for rejection or cancellation.');
  }
  return mongoose.connection.transaction(async session => {
    const withdrawal = await Withdrawal.findById(id).session(session);
    if (!withdrawal) throw new PayoutError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');
    if (withdrawal.status === status) return withdrawalView(withdrawal);
    if (!reviewTransitions[withdrawal.status]?.includes(status)) {
      throw new PayoutError(409, 'INVALID_TRANSITION', 'The withdrawal cannot move to this status.');
    }

    const from = withdrawal.status;
    if (refund) {
      const { userId, currency, cost } = withdrawal;
      const path = `balances.${currency}`;
      const before = await Wallet.findOneAndUpdate(
        { _id: userId, [path]: { $lte: Number.MAX_SAFE_INTEGER - cost } },
        { $inc: { [path]: cost } },
        { session, returnDocument: 'before' },
      ).lean();
      if (!before) throw new PayoutError(409, 'REFUND_UNAVAILABLE', 'The withdrawal could not be refunded.');
      const [entry] = await Ledger.create([{
        userId, withdrawalId: id, currency, type: 'CREDIT', amount: cost,
        balanceBefore: before.balances[currency], balanceAfter: before.balances[currency] + cost,
        source: 'WITHDRAWAL_REVERSAL', description: 'Withdrawal refund',
      }], { session });
      withdrawal.refundLedgerId = entry._id;
      withdrawal.rejectionReason = reason.trim();
    }
    withdrawal.status = status;
    await withdrawal.save({ session });
    await WithdrawalEvent.create([{
      withdrawalId: id, actor: 'review-service', from, to: status,
      reason: withdrawal.rejectionReason,
    }], { session });
    return withdrawalView(withdrawal);
  }, { writeConcern: { w: 'majority' } });
}
