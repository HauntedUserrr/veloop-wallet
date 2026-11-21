import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;
const schema = (fields, options) => new mongoose.Schema(fields, { timestamps: true, ...options });
const positiveInteger = { type: Number, required: true, min: 1, validate: Number.isSafeInteger };
export const currencies = ['ves', 'sves', 'gems', 'tokens', 'spins'];
export const statuses = ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'];
export const accountStatuses = ['ACTIVE', 'REVIEW', 'SUSPENDED'];
export const creditSources = ['REWARD', 'BONUS', 'REFERRAL', 'DAILY_REWARD', 'AD_REWARD', 'GAME_REWARD', 'ADMIN_CREDIT', 'CORRECTION'];
export const debitSources = ['ADMIN_DEBIT', 'CORRECTION'];

const user = schema({
  email: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  passwordHash: { type: String, select: false },
  role: { type: String, enum: ['USER', 'ADMIN'], default: 'USER' },
  status: { type: String, enum: accountStatuses, default: 'ACTIVE' },
  verified: { type: Boolean, default: false },
  region: { type: String, default: 'IN' },
  demo: { type: Boolean, default: false },
  demoAccess: { type: String, enum: ['public', 'evaluator'] },
  sessionVersion: { type: Number, default: 0, select: false },
});
user.index({ demo: 1, role: 1, createdAt: 1, _id: 1 });
user.index({ demo: 1, demoAccess: 1 });

const wallet = schema({
  _id: ObjectId,
  balances: Object.fromEntries(currencies.map(currency => [
    currency, { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
  ])),
});

const ledger = schema({
  userId: { type: ObjectId, required: true },
  currency: { type: String, enum: currencies, required: true },
  type: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: positiveInteger,
  balanceBefore: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  source: { type: String, required: true },
  referenceId: { type: String, required: true },
  status: { type: String, default: 'POSTED' },
  description: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
ledger.index({ userId: 1, createdAt: -1, _id: -1 });
ledger.index({ userId: 1, source: 1, referenceId: 1, currency: 1, type: 1 }, { unique: true });
ledger.index({ referenceId: 1 });

const method = schema({
  _id: String,
  name: { type: String, required: true },
  active: { type: Boolean, default: false },
  detailType: { type: String, enum: ['UPI_ID', 'EMAIL'], required: true },
  detailLabel: { type: String, required: true },
  regions: [String],
  order: Number,
});
const option = schema({
  _id: String,
  method: { type: String, required: true },
  currency: { type: String, enum: currencies, required: true },
  requiredAmount: positiveInteger,
  payoutMinor: positiveInteger,
  payoutCurrency: { type: String, enum: ['INR'], default: 'INR' },
  active: { type: Boolean, default: false },
});
option.index({ method: 1, active: 1, payoutMinor: 1 });

const withdrawal = schema({
  userId: { type: ObjectId, required: true },
  method: { type: String, required: true },
  methodName: { type: String, required: true },
  optionId: { type: String, required: true },
  currency: { type: String, enum: currencies, required: true },
  currencyAmount: positiveInteger,
  payoutMinor: positiveInteger,
  payoutCurrency: { type: String, required: true },
  payoutDetails: { type: String, required: true, select: false },
  idempotencyKey: { type: String, required: true, select: false },
  requestHash: { type: String, required: true, select: false },
  status: { type: String, enum: statuses, default: 'PENDING' },
  transactionId: { type: ObjectId, required: true },
  refundTransactionId: ObjectId,
  rejectionReason: String,
  reviewNote: { type: String, select: false },
  processedAt: Date,
}, { timestamps: { createdAt: 'requestedAt', updatedAt: true } });
withdrawal.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
withdrawal.index({ userId: 1, requestedAt: -1, _id: -1 });
withdrawal.index({ userId: 1, currency: 1, status: 1 });
withdrawal.index({ status: 1, requestedAt: -1, _id: -1 });
withdrawal.index({ requestedAt: -1, _id: -1 });

const audit = schema({
  actorId: { type: ObjectId, required: true },
  targetUserId: ObjectId,
  action: { type: String, required: true },
  targetType: { type: String, required: true },
  referenceId: { type: String, required: true },
  metadata: Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });
audit.index({ targetUserId: 1, createdAt: -1 });
audit.index({ referenceId: 1, createdAt: -1 });

const requestBudget = new mongoose.Schema({
  _id: String,
  hits: Number,
  expiresAt: { type: Date, expires: 0 },
});

export const User = mongoose.model('User', user);
export const Wallet = mongoose.model('Wallet', wallet);
export const Ledger = mongoose.model('WalletTransaction', ledger);
export const PayoutMethod = mongoose.model('PayoutMethod', method);
export const PayoutOption = mongoose.model('PayoutOption', option);
export const Withdrawal = mongoose.model('Withdrawal', withdrawal);
export const AuditLog = mongoose.model('AuditLog', audit);
export const RequestBudget = mongoose.model('RequestBudget', requestBudget);

export async function initializeModels() {
  await Promise.all(
    [User, Wallet, Ledger, PayoutMethod, PayoutOption, Withdrawal, AuditLog, RequestBudget].map(model => model.init()),
  );
}
