import mongoose from 'mongoose';
import { initializeModels } from './models.js';
import { WithdrawalIntent } from './withdrawal-intent.js';

export async function connectDatabase(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 20 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('MongoDB must be a replica set or sharded cluster to support wallet transactions.');
  }
  await Promise.all([initializeModels(), WithdrawalIntent.init()]);
}
