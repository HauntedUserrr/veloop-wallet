import mongoose from 'mongoose';

const withdrawalIntent = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, select: false },
  state: { type: String, enum: ['OPEN', 'ABANDONED'], required: true },
  // Keep discard records after the submission deadline so outstanding requests can finish or fail.
  expiresAt: { type: Date, required: true, expires: 24 * 60 * 60 },
  lockVersion: Number,
});

withdrawalIntent.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

export const WithdrawalIntent = mongoose.model('WithdrawalIntent', withdrawalIntent);
