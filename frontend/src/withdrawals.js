import { request } from './api.js';

const detailErrors = new Set([
  'INVALID_DETAILS', 'QUOTE_CHANGED', 'METHOD_UNAVAILABLE', 'OPTION_UNAVAILABLE', 'INELIGIBLE',
]);

export function shouldReloadCatalog(error) {
  return error.code !== 'INVALID_DETAILS' && detailErrors.has(error.code);
}

export function savedAttempts(prefix) {
  return Object.keys(sessionStorage)
    .filter(key => key.startsWith(prefix))
    .map(storageKey => ({
      storageKey,
      optionId: storageKey.slice(prefix.length),
      key: sessionStorage.getItem(storageKey),
    }))
    .filter(attempt => attempt.key);
}

export function forgetAttempt({ storageKey, key }) {
  if (sessionStorage.getItem(storageKey) === key) {
    sessionStorage.removeItem(storageKey);
  }
}

export async function completedWithdrawal(token, { key }) {
  try {
    const { withdrawal } = await request('/withdrawals/attempt', {
      token, headers: { 'Idempotency-Key': key },
    });
    return withdrawal;
  } catch (error) {
    if (error.code === 'WITHDRAWAL_NOT_FOUND') return null;
    throw error;
  }
}

export function abandonAttempt(token, { key }) {
  return request('/withdrawals/intents', {
    token, method: 'DELETE', headers: { 'Idempotency-Key': key },
  });
}

export async function submitWithdrawal(token, attempt) {
  const { key, storageKey, body } = attempt;
  const storedKey = sessionStorage.getItem(storageKey);
  if (storedKey && storedKey !== key) {
    throw Object.assign(new Error('Resolve the saved withdrawal first.'), { status: 409 });
  }
  if (storedKey) {
    const receipt = await completedWithdrawal(token, attempt);
    if (receipt) return receipt;
  }

  sessionStorage.setItem(storageKey, key);
  const submission = { token, body, method: 'POST', headers: { 'Idempotency-Key': key } };
  let debitRequested = false;
  try {
    await request('/withdrawals/intents', submission);
    debitRequested = true;
    const { withdrawal } = await request('/withdrawals', submission);
    return withdrawal;
  } catch (error) {
    // If recovery fails, keep the key and report the original error.
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      const receipt = await completedWithdrawal(token, attempt).catch(() => null);
      if (receipt) return receipt;
    }
    if (!storedKey && !debitRequested && detailErrors.has(error.code)) {
      const result = await abandonAttempt(token, attempt).catch(() => null);
      if (result?.withdrawal) return result.withdrawal;
      if (result?.abandoned) forgetAttempt(attempt);
    }
    throw error;
  }
}
