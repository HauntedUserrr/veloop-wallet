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
  currency: { type: String, enum: currencies, required: true },
  type: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  balanceBefore: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  balanceAfter: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  source: { type: String, required: true },
  description: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
entry.index({ userId: 1, createdAt: -1, _id: -1 });

export const User = mongoose.model('User', user);
export const Wallet = mongoose.model('Wallet', wallet);
export const Ledger = mongoose.model('WalletTransaction', entry);

export async function connectDatabase(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const topology = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== 'isdbgrid') {
    throw new Error('Use a MongoDB replica set or sharded cluster for wallet transactions.');
  }
  await Promise.all([User.init(), Wallet.init(), Ledger.init()]);
}
