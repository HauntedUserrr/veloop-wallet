import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export function loadConfig() {
  const values = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
    JWT_SECRET: z.string().min(32),
    PAYOUT_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
    CLIENT_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    DEMO_ENABLED: z.enum(['true', 'false']).default('false'),
    EVALUATOR_ACCESS_CODE: z.string().max(128).refine(value => value === '' || value.length >= 24).default(''),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  }).parse(process.env);
  return {
    port: values.PORT,
    host: values.API_HOST,
    mongoUri: values.MONGO_URI,
    jwtSecret: values.JWT_SECRET,
    payoutKey: Buffer.from(values.PAYOUT_ENCRYPTION_KEY, 'hex'),
    origins: values.CLIENT_ORIGINS.split(',').map(value => value.trim()).filter(Boolean),
    demo: values.DEMO_ENABLED === 'true',
    evaluatorCode: values.EVALUATOR_ACCESS_CODE,
    trustProxy: values.TRUST_PROXY_HOPS,
  };
}
