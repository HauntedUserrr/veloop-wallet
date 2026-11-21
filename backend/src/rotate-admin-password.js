import mongoose from 'mongoose';
import { administratorCredentials, rotateAdminPassword } from './auth.js';
import { loadConfig } from './config.js';
import { connectDatabase } from './database.js';

try {
  const { mongoUri } = loadConfig();
  const credentials = administratorCredentials.parse({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_NEW_PASSWORD,
  });
  await connectDatabase(mongoUri);
  await rotateAdminPassword(credentials.email, credentials.password);
  console.log('Administrator password rotated. Existing sessions were revoked.');
} catch (error) {
  const reason = error.code === 'ADMIN_NOT_FOUND' ? 'Administrator account not found.'
    : error.issues ? 'Check ADMIN_EMAIL, ADMIN_NEW_PASSWORD, and the database environment.'
    : 'Check database availability and retry.';
  console.error(`Administrator password rotation failed. ${reason}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
