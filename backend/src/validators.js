import { z } from 'zod';
import { currencies, creditSources, debitSources, statuses } from './models.js';
import { fail } from './errors.js';

export const mongoId = z.string().regex(/^[a-f\d]{24}$/i);
export const catalogId = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const currency = z.enum(currencies);
const amount = z.int().positive();
const payoutMinor = amount.min(1000);
const text = (max) => z.string().trim().min(1).max(max);
const description = text(200);
const referenceId = z.string().trim().regex(/^[a-z\d][a-z\d:_-]{0,79}$/i);
const pageNumber = (max, fallback) => z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().min(1).max(max)).optional().transform(value => value ?? fallback);

export const MAX_HISTORY_PAGE = 500;
export const paging = z.strictObject({ page: pageNumber(MAX_HISTORY_PAGE, 1), limit: pageNumber(50, 20) });
export const summaryPaging = paging.extend({ limit: pageNumber(50, 5) });
export const withdrawalFilters = paging.extend({
  status: z.enum(statuses).optional(),
  userId: mongoId.optional(),
});
export const credentials = z.strictObject({
  email: z.email().max(254).transform(value => value.toLowerCase()), password: z.string().min(1).max(128),
});
export const evaluatorCredentials = z.strictObject({ accessCode: z.string().min(1).max(128) });
export const idempotency = z.string().regex(/^[a-z\d][a-z\d_-]{15,95}$/i);
export const withdrawalRequest = z.strictObject({
  method: catalogId, optionId: catalogId, payoutDetail: text(254),
  expectedRequiredAmount: amount, expectedPayoutMinor: payoutMinor,
});

export function adjustment(type) {
  return z.strictObject({
    userId: mongoId, currency, amount, description, referenceId,
    source: z.enum(type === 'CREDIT' ? creditSources : debitSources),
  });
}

export const exchange = z.strictObject({
  userId: mongoId, fromCurrency: currency, toCurrency: currency,
  fromAmount: amount, toAmount: amount, description, referenceId,
}).refine(value => value.fromCurrency !== value.toCurrency, 'Use two different currencies.');

export const review = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['PROCESSING', 'APPROVED']), note: text(300).optional() }),
  z.strictObject({ status: z.enum(['REJECTED', 'CANCELLED']), note: text(300).optional(), reason: text(160) }),
]);

export const optionChanges = z.strictObject({
  active: z.boolean().optional(), requiredAmount: amount.optional(), payoutMinor: payoutMinor.optional(),
}).refine(value => Object.keys(value).length > 0, 'Provide at least one option field.');

export const newOption = z.strictObject({
  id: catalogId, method: catalogId, currency, requiredAmount: amount, payoutMinor,
  active: z.boolean().default(false),
});

export const methodChanges = z.strictObject({
  active: z.boolean().optional(),
  regions: z.array(z.string().regex(/^[A-Z]{2}$/)).max(32)
    .transform(regions => [...new Set(regions)]).optional(),
  detailType: z.enum(['UPI_ID', 'EMAIL']).optional(),
  detailLabel: text(60).optional(),
}).refine(value => Object.keys(value).length > 0, 'Provide at least one method field.');

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    fail(422, 'VALIDATION_ERROR', field ? `Invalid field: ${field}.` : 'Invalid request parameters.');
  }
  return result.data;
}
