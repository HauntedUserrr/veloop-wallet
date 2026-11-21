import mongoose from 'mongoose';
import { administratorCredentials, hashPassword } from './auth.js';
import { seedCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { connectDatabase } from './database.js';
import { User } from './models.js';

try {
  const config = loadConfig();
  await connectDatabase(config.mongoUri);
  await seedCatalog();
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (email || password) {
    const admin = administratorCredentials.parse({ email, password });
    const existing = await User.findOne({ email: admin.email });
    if (existing && existing.role !== 'ADMIN') throw new Error('The requested email already belongs to a non-admin user.');
    if (!existing) {
      await User.create({
        email: admin.email, passwordHash: await hashPassword(admin.password),
        name: 'Wallet administrator', role: 'ADMIN',
      });
    }
  }
  console.log('Demo payout catalog initialized.');
} catch (error) {
  console.error('Seed failed.', error.name, error.issues?.map(issue => issue.path.join('.')).join(', '));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
