import mongoose from 'mongoose';

export const currencies = ['ves', 'sves', 'gems', 'tokens', 'spins'];
const { ObjectId } = mongoose.Schema.Types;

const user = new mongoose.Schema({
  name: { type: String, required: true },
  demo: { type: Boolean, default: false },
}, { timestamps: true });

const wallet = new mongoose.Schema({
  _id: { type: ObjectId, ref: 'User' },
  balances: Object.fromEntries(currencies.map(currency => [currency, {
    type: Number, required: true, min: 0, validate: Number.isSafeInteger,
  }])),
}, { timestamps: true });

const entry = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  withdrawalId: { type: ObjectId, ref: 'Withdrawal' },
  currency: { type: String, enum: currencies, required: true },
  type: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  balanceBefore: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  balanceAfter: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  source: { type: String, required: true },
  description: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
entry.index({ userId: 1, createdAt: -1, _id: -1 });

const positiveInteger = { type: Number, required: true, min: 1, validate: Number.isSafeInteger };

const payoutOption = new mongoose.Schema({
  _id: String,
  method: { type: String, enum: ['upi'], required: true },
  currency: { type: String, enum: currencies, required: true },
  cost: positiveInteger,
  amountPaise: { ...positiveInteger, min: 1000 },
  active: { type: Boolean, default: true },
});

const withdrawal = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  optionId: { type: String, required: true },
  method: { type: String, enum: ['upi'], required: true },
  currency: { type: String, enum: currencies, required: true },
  cost: positiveInteger,
  amountPaise: positiveInteger,
  status: { type: String, enum: ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'], required: true },
  ledgerId: { type: ObjectId, ref: 'WalletTransaction', required: true },
  refundLedgerId: { type: ObjectId, ref: 'WalletTransaction' },
  rejectionReason: String,
  idempotencyKey: { type: String, required: true, select: false },
  requestFingerprint: { type: String, required: true, select: false },
  encryptedDestination: { type: String, required: true, select: false },
}, { timestamps: true });
withdrawal.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
withdrawal.index({ userId: 1, createdAt: -1, _id: -1 });

const withdrawalEvent = new mongoose.Schema({
  withdrawalId: { type: ObjectId, ref: 'Withdrawal', required: true },
  actor: { type: String, required: true },
  from: String,
  to: { type: String, required: true },
  reason: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
withdrawalEvent.index({ withdrawalId: 1, createdAt: 1 });

export const User = mongoose.model('User', user);
export const Wallet = mongoose.model('Wallet', wallet);
export const Ledger = mongoose.model('WalletTransaction', entry);
export const PayoutOption = mongoose.model('PayoutOption', payoutOption);
export const Withdrawal = mongoose.model('Withdrawal', withdrawal);
export const WithdrawalEvent = mongoose.model('WithdrawalEvent', withdrawalEvent);

export async function connectDatabase(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const topology = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== 'isdbgrid') {
    throw new Error('Use a MongoDB replica set or sharded cluster for wallet transactions.');
  }
  await Promise.all([User, Wallet, Ledger, PayoutOption, Withdrawal, WithdrawalEvent].map(model => model.init()));
}
