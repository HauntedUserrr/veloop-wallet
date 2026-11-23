import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { fail } from '../errors.js';
import { AuditLog, PayoutMethod, PayoutOption, Withdrawal, statuses } from '../models.js';
import { WithdrawalIntent } from '../withdrawal-intent.js';
import { activeAdministrator, activeUser, audit, paginate, postEntry, transact } from './wallet.js';

const methodSort = { order: 1, _id: 1 };
const intentLifetime = 125 * 60_000;
const acceptedClockSkew = 5 * 60_000;
const transitions = {
  PENDING: ['PROCESSING', 'REJECTED', 'CANCELLED'],
  PROCESSING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};
const auditStatuses = {
  WITHDRAWAL_CREATED: 'PENDING',
  WITHDRAWAL_PROCESSING: 'PROCESSING',
  WITHDRAWAL_APPROVED: 'APPROVED',
  WITHDRAWAL_REJECTED: 'REJECTED',
  WITHDRAWAL_CANCELLED: 'CANCELLED',
};

function eligible(user, method) {
  return user.status === 'ACTIVE' && user.verified
    && (method.regions.length === 0 || method.regions.includes(user.region));
}

export async function listOptions(user, methodId, { includeOptions = true } = {}) {
  const methods = await PayoutMethod.find(methodId ? { _id: methodId } : {}).sort(methodSort).lean();
  if (methodId && methods.length === 0) fail(404, 'METHOD_NOT_FOUND', 'Payout method not found.');
  const optionsByMethod = new Map();
  const eligibleIds = new Set(methods
    .filter(method => method.active && eligible(user, method))
    .map(method => method._id));
  if (includeOptions && eligibleIds.size) {
    const options = await PayoutOption.find({ method: { $in: [...eligibleIds] }, active: true })
      .sort({ method: 1, payoutMinor: 1, _id: 1 }).lean();
    for (const option of options) {
      if (!optionsByMethod.has(option.method)) optionsByMethod.set(option.method, []);
      optionsByMethod.get(option.method).push({
        id: option._id, currency: option.currency, requiredAmount: option.requiredAmount,
        payoutMinor: option.payoutMinor, payoutCurrency: option.payoutCurrency,
      });
    }
  }
  return methods.map(method => ({
    id: method._id,
    name: method.name,
    active: method.active,
    eligible: eligibleIds.has(method._id),
    detailType: method.detailType,
    detailLabel: method.detailLabel,
    ...(includeOptions && { options: optionsByMethod.get(method._id) ?? [] }),
  }));
}

function validateDestination(type, detail) {
  const schema = type === 'UPI_ID'
    ? z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}@[a-z0-9][a-z0-9.-]{1,63}$/)
    : z.email();
  if (!schema.safeParse(detail).success) fail(422, 'INVALID_DETAILS', 'Enter valid payout details for this method.');
}

function encrypt(detail, key, id) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(id)));
  const ciphertext = Buffer.concat([cipher.update(detail, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function publicWithdrawal(record) {
  const { _id, userId, method, methodName, optionId, currency, currencyAmount,
    payoutMinor, payoutCurrency, status, transactionId, refundTransactionId,
    requestedAt, processedAt, updatedAt, rejectionReason } = record;
  return { id: _id, userId, method, methodName, optionId, currency, currencyAmount,
    payoutMinor, payoutCurrency, status, transactionId, refundTransactionId,
    requestedAt, processedAt, updatedAt, rejectionReason };
}

function assertSameWithdrawal(existing, requestHash) {
  if (existing.requestHash !== requestHash) {
    fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key is already linked to different payout details.');
  }
}

function replay(existing, requestHash) {
  assertSameWithdrawal(existing, requestHash);
  return { withdrawal: publicWithdrawal(existing), replayed: true };
}

function withdrawalFingerprint(body, detail, key) {
  return createHmac('sha256', key)
    .update(JSON.stringify([body.method, body.optionId, detail, body.expectedRequiredAmount, body.expectedPayoutMinor]))
    .digest('hex');
}

function intentDeadline(key) {
  if (!key.startsWith('wd1-')) return null;
  const match = key.match(/^wd1-(\d{13})-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
  const createdAt = Number(match?.[1]);
  if (!createdAt || createdAt > Date.now() + acceptedClockSkew) {
    fail(422, 'INTENT_KEY_INVALID', 'The withdrawal request key is invalid.');
  }
  return new Date(createdAt + intentLifetime);
}

function assertUnexpired(deadline) {
  if (deadline && deadline.getTime() <= Date.now()) {
    fail(409, 'INTENT_EXPIRED', 'This withdrawal request expired. Check its status before starting another.');
  }
}

function assertOpenIntent(intent, requestHash) {
  if (!intent) fail(409, 'INTENT_REQUIRED', 'Review the details and prepare this withdrawal before submitting.');
  if (intent.state === 'ABANDONED') fail(409, 'INTENT_ABANDONED', 'This withdrawal request was discarded.');
  assertUnexpired(intent.expiresAt);
  assertSameWithdrawal(intent, requestHash);
}

async function bindWithdrawalIntent(lookup, requestHash, deadline) {
  assertUnexpired(deadline);
  const fields = {
    requestHash, state: 'OPEN', expiresAt: deadline ?? new Date(Date.now() + intentLifetime),
  };
  let intent;
  try {
    intent = await WithdrawalIntent.findOneAndUpdate(
      lookup, { $setOnInsert: fields }, { upsert: true, returnDocument: 'after' },
    ).select('+requestHash').lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    intent = await WithdrawalIntent.findOne(lookup).select('+requestHash').lean();
  }
  assertOpenIntent(intent, requestHash);
}

async function validatePayout(userId, body, detail, session = null) {
  const user = await activeUser(userId, session);
  const method = await PayoutMethod.findById(body.method).session(session);
  if (!method?.active) fail(422, 'METHOD_UNAVAILABLE', 'This payout method is currently unavailable.');
  if (!eligible(user, method)) fail(403, 'INELIGIBLE', 'This account is not eligible for this payout method.');
  const option = await PayoutOption.findOne({ _id: body.optionId, method: method._id, active: true }).session(session);
  if (!option) fail(422, 'OPTION_UNAVAILABLE', 'Selected payout option is unavailable.');
  if (option.requiredAmount !== body.expectedRequiredAmount || option.payoutMinor !== body.expectedPayoutMinor) {
    fail(409, 'QUOTE_CHANGED', 'The payout price changed. Refresh the options and confirm again.');
  }
  validateDestination(method.detailType, detail);
  return { user, method, option };
}

export async function prepareWithdrawal(userId, body, idempotencyKey, config) {
  const lookup = { userId, idempotencyKey };
  const detail = body.payoutDetail.trim().toLowerCase();
  const requestHash = withdrawalFingerprint(body, detail, config.payoutKey);
  const existing = await Withdrawal.findOne(lookup).select('+requestHash');
  if (existing) {
    assertSameWithdrawal(existing, requestHash);
    return { prepared: true };
  }

  const deadline = intentDeadline(idempotencyKey);
  assertUnexpired(deadline);
  const intent = await WithdrawalIntent.findOne(lookup).select('+requestHash').lean();
  if (intent) {
    assertOpenIntent(intent, requestHash);
  } else {
    await validatePayout(userId, body, detail);
    await bindWithdrawalIntent(lookup, requestHash, deadline);
  }
  return { prepared: true };
}

export async function createWithdrawal(userId, body, idempotencyKey, config) {
  const lookup = { userId, idempotencyKey };
  const detail = body.payoutDetail.trim().toLowerCase();
  const requestHash = withdrawalFingerprint(body, detail, config.payoutKey);
  const existing = await Withdrawal.findOne(lookup).select('+requestHash');
  if (existing) return replay(existing, requestHash);

  const deadline = intentDeadline(idempotencyKey);
  assertUnexpired(deadline);
  if (!deadline) await bindWithdrawalIntent(lookup, requestHash, deadline);

  try {
    return await transact(async session => {
      const existing = await Withdrawal.findOne(lookup).select('+requestHash').session(session);
      if (existing) return replay(existing, requestHash);

      // Discarding an intent writes the same record, so it must happen before or after the debit.
      const intent = await WithdrawalIntent.findOneAndUpdate(
        lookup, { $inc: { lockVersion: 1 } }, { session, returnDocument: 'after' },
      ).select('+requestHash').lean();
      assertOpenIntent(intent, requestHash);
      const { user, method, option } = await validatePayout(userId, body, detail, session);
      const id = new mongoose.Types.ObjectId();
      const payoutDetails = encrypt(user.demo ? 'sandbox' : detail, config.payoutKey, id);
      const transaction = await postEntry({
        userId, currency: option.currency, type: 'DEBIT', amount: option.requiredAmount,
        source: 'WITHDRAWAL', referenceId: String(id), description: `${method.name} redemption`,
      }, userId, session);
      const [withdrawal] = await Withdrawal.create([{
        _id: id, userId, method: method._id, methodName: method.name, optionId: option._id,
        currency: option.currency, currencyAmount: option.requiredAmount,
        payoutMinor: option.payoutMinor, payoutCurrency: option.payoutCurrency,
        payoutDetails, idempotencyKey, requestHash, transactionId: transaction._id,
      }], { session });
      await audit({
        actorId: userId, targetUserId: userId, action: 'WITHDRAWAL_CREATED',
        targetType: 'WITHDRAWAL', referenceId: String(id),
        metadata: { method: method._id, optionId: option._id, transactionId: transaction._id },
      }, session);
      return { withdrawal: publicWithdrawal(withdrawal), replayed: false };
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Withdrawal.findOne(lookup).select('+requestHash');
      if (existing) return replay(existing, requestHash);
    }
    throw error;
  }
}

export async function abandonWithdrawalIntent(userId, idempotencyKey) {
  const lookup = { userId, idempotencyKey };
  const deadline = intentDeadline(idempotencyKey);
  const discard = () => transact(async session => {
    const existing = await Withdrawal.findOne(lookup).session(session);
    if (existing) return { abandoned: false, withdrawal: publicWithdrawal(existing) };

    await WithdrawalIntent.findOneAndUpdate(
      lookup,
      {
        $set: { state: 'ABANDONED' },
        $setOnInsert: { expiresAt: deadline ?? new Date(Date.now() + intentLifetime) },
      },
      { session, upsert: true },
    );
    return { abandoned: true };
  });

  try {
    return await discard();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return discard();
  }
}

export async function listWithdrawals(filter, paging) {
  const result = await paginate(Withdrawal.find(filter), { requestedAt: -1, _id: -1 }, paging);
  return { ...result, records: result.records.map(publicWithdrawal) };
}

export async function getWithdrawal(filter) {
  const result = await Withdrawal.findOne(filter);
  if (!result) fail(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');
  return publicWithdrawal(result);
}

export async function getWithdrawalReviewHistory(id) {
  const withdrawal = await Withdrawal.findById(id).select('userId status rejectionReason +reviewNote').lean();
  if (!withdrawal) fail(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');

  const events = await AuditLog.find({
    targetType: 'WITHDRAWAL',
    targetUserId: withdrawal.userId,
    // Older review events could store the same ID in the casing used by the request.
    referenceId: new RegExp(`^${withdrawal._id}$`, 'i'),
    action: { $in: Object.keys(auditStatuses) },
  }).select('actorId action createdAt metadata.previousStatus metadata.note metadata.reason metadata.refundTransactionId')
    .sort({ createdAt: 1, _id: 1 }).lean();

  return events.map(event => {
    const metadata = event.metadata ?? {};
    const status = auditStatuses[event.action];
    const currentReview = status !== 'PENDING' && status === withdrawal.status;
    const legacyNote = currentReview && !Object.hasOwn(metadata, 'note');
    const note = legacyNote ? withdrawal.reviewNote : metadata.note;
    const reason = metadata.reason ?? (currentReview ? withdrawal.rejectionReason : undefined);
    return {
      id: event._id,
      actorId: event.actorId,
      action: event.action,
      previousStatus: statuses.includes(metadata.previousStatus) ? metadata.previousStatus : null,
      status,
      createdAt: event.createdAt,
      ...(typeof note === 'string' && { note }),
      ...(typeof reason === 'string' && { reason }),
      ...(mongoose.isObjectIdOrHexString(metadata.refundTransactionId) && { refundTransactionId: metadata.refundTransactionId }),
    };
  });
}

export function reviewWithdrawal(actorId, id, { status, reason, note }) {
  return transact(async session => {
    await activeAdministrator(actorId, session);
    const withdrawal = await Withdrawal.findById(id).session(session);
    if (!withdrawal) fail(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found.');
    if (withdrawal.status === status) return publicWithdrawal(withdrawal);
    if (!transitions[withdrawal.status].includes(status)) {
      fail(409, 'INVALID_TRANSITION', 'This withdrawal cannot move to the requested status.');
    }
    if (status === 'PROCESSING' || status === 'APPROVED') {
      const user = await activeUser(withdrawal.userId, session);
      const method = await PayoutMethod.findById(withdrawal.method).session(session);
      if (!method?.active || !eligible(user, method)) {
        fail(403, 'INELIGIBLE', 'This account or payout method is no longer eligible.');
      }
    }

    const previousStatus = withdrawal.status;
    const referenceId = String(withdrawal._id);
    withdrawal.status = status;
    if (note !== undefined) withdrawal.reviewNote = note;
    if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) withdrawal.processedAt = new Date();
    if (status === 'REJECTED' || status === 'CANCELLED') {
      withdrawal.rejectionReason = reason;
      const refund = await postEntry({
        userId: withdrawal.userId, currency: withdrawal.currency, type: 'CREDIT',
        amount: withdrawal.currencyAmount, source: 'WITHDRAWAL_REVERSAL',
        referenceId, description: 'Withdrawal reversal',
      }, actorId, session);
      withdrawal.refundTransactionId = refund._id;
    }
    await withdrawal.save({ session });
    await audit({
      actorId, targetUserId: withdrawal.userId, action: `WITHDRAWAL_${status}`,
      targetType: 'WITHDRAWAL', referenceId,
      metadata: { previousStatus, note: note ?? null, reason: reason ?? null, refundTransactionId: withdrawal.refundTransactionId },
    }, session);
    return publicWithdrawal(withdrawal);
  });
}

async function configureCatalog(actorId, model, targetType, id, changes) {
  return transact(async session => {
    await activeAdministrator(actorId, session);
    const item = await model.findById(id).session(session);
    if (!item) fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Payout configuration item not found.');
    if (model === PayoutMethod && changes.active === true && !item.active
      && !await PayoutOption.exists({ method: id, active: true }).session(session)) {
      fail(409, 'METHOD_HAS_NO_OPTIONS', 'Add an active option before enabling this method.');
    }
    const previous = Object.fromEntries(Object.keys(changes).map(key => [key, item.get(key)]));
    item.set(changes);
    if (!item.isModified()) return item;
    await item.save({ session });
    await audit({
      actorId, action: 'PAYOUT_CONFIGURATION_CHANGED', targetType,
      referenceId: id, metadata: { previous, changes },
    }, session);
    return item;
  });
}

export function updateMethod(actorId, id, changes) {
  return configureCatalog(actorId, PayoutMethod, 'PAYOUT_METHOD', id, changes);
}

export function updateOption(actorId, id, changes) {
  return configureCatalog(actorId, PayoutOption, 'PAYOUT_OPTION', id, changes);
}

export async function addOption(actorId, { id, ...fields }) {
  try {
    return await transact(async session => {
      await activeAdministrator(actorId, session);
      if (!await PayoutMethod.exists({ _id: fields.method }).session(session)) {
        fail(404, 'METHOD_NOT_FOUND', 'Payout method not found.');
      }
      const [option] = await PayoutOption.create([{ _id: id, ...fields }], { session });
      await audit({
        actorId, action: 'PAYOUT_CONFIGURATION_CHANGED', targetType: 'PAYOUT_OPTION',
        referenceId: id, metadata: { changes: fields },
      }, session);
      return option;
    });
  } catch (error) {
    if (error.code === 11000) fail(409, 'OPTION_EXISTS', 'A payout option already uses this ID.');
    throw error;
  }
}
