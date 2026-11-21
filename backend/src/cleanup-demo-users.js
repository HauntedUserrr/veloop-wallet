import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { loadConfig } from './config.js';
import { connectDatabase } from './database.js';
import { AuditLog, Ledger, User, Wallet, Withdrawal } from './models.js';
import { transact } from './services/wallet.js';
import { WithdrawalIntent } from './withdrawal-intent.js';

const demoEmail = /^demo-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@veloop\.test$/;

export async function purgeExpiredDemoUsers({ days = 7, limit = 250, apply = false } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365
    || !Number.isInteger(limit) || limit < 1 || limit > 500 || typeof apply !== 'boolean') {
    throw new Error('Expected days from 1 to 365, limit from 1 to 500, and an explicit Boolean apply flag.');
  }
  // Demo accounts have no password and only receive a two-hour token at creation.
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const eligible = {
    demo: true,
    role: 'USER',
    email: demoEmail,
    passwordHash: null,
    createdAt: { $lt: cutoff },
  };
  const candidates = await User.find(eligible).select('_id').sort({ createdAt: 1, _id: 1 }).limit(limit).lean();
  let deleted = 0;

  if (apply) {
    for (const { _id } of candidates) {
      const removed = await transact(async session => {
        const user = await User.findOneAndDelete({ _id, ...eligible }).session(session);
        if (!user) return false;
        await Wallet.deleteOne({ _id }).session(session);
        await Ledger.deleteMany({ userId: _id }).session(session);
        await Withdrawal.deleteMany({ userId: _id }).session(session);
        await WithdrawalIntent.deleteMany({ userId: _id }).session(session);
        await AuditLog.deleteMany({ targetUserId: _id }).session(session);
        return true;
      });
      if (removed) deleted += 1;
    }
  }

  return { matched: candidates.length, deleted, apply };
}

async function main() {
  try {
    const { values } = parseArgs({
      options: { days: { type: 'string' }, limit: { type: 'string' }, apply: { type: 'boolean' } },
    });
    const options = {
      days: Number(values.days ?? 7),
      limit: Number(values.limit ?? 250),
      apply: values.apply === true,
    };
    const { mongoUri } = loadConfig();
    await connectDatabase(mongoUri);
    const report = await purgeExpiredDemoUsers(options);
    console.log(JSON.stringify(report));
  } catch {
    console.error('Demo cleanup stopped. Check the database connection and use --days 1–365 and --limit 1–500.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
