import { useEffect, useState } from 'react';
import { request } from './api.js';

export const currencyNames = { ves: 'VEs', sves: 'SVEs', gems: 'Gems', tokens: 'Tokens', spins: 'Spins' };
export const number = new Intl.NumberFormat('en-IN');
const date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDate = value => date.format(new Date(value));
export function money({ payoutMinor, payoutCurrency }) {
  const minorUnits = BigInt(payoutMinor);
  const fraction = minorUnits % 100n;
  const fractionDigits = fraction ? 2 : 0;
  const formatter = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: payoutCurrency,
    minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
  });
  return formatter.formatToParts(minorUnits / 100n).map(({ type, value }) =>
    type === 'fraction' ? fraction.toString().padStart(2, '0') : value).join('');
}

export function useApi(token, path, version = 0) {
  const [result, setResult] = useState({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const associatedRequest = { path, version, attempt, token };
    request(path, { token, signal })
      .then(data => { if (!signal.aborted) setResult({ ...associatedRequest, data }) })
      .catch(error => { if (!signal.aborted) setResult({ ...associatedRequest, error }) });
    return () => controller.abort();
  }, [token, path, version, attempt]);

  const matches = result.path === path && result.version === version
    && result.attempt === attempt && result.token === token;
  return {
    data: matches ? result.data : undefined,
    error: matches ? result.error : undefined,
    reload: () => setAttempt(value => value + 1),
  };
}

export function ErrorMessage({ error, retry }) {
  if (!error) return null;
  return <div className="message error" role="alert">
    <span>{error.message}</span>
    {retry && <button type="button" className="button small" onClick={retry}>Try again</button>}
  </div>;
}

export function Loading() {
  return <p className="empty" role="status">Loading…</p>;
}

export function Balance({ currency, value }) {
  return <div className="balance">
    <dt>{currencyNames[currency]}</dt>
    <dd>{number.format(value)}</dd>
  </div>;
}

export function Pagination({ page, hasMore, changePage }) {
  return <div className="pagination">
    <span>Page {page}</span>
    <div>
      <button className="button small" aria-label="Previous page" disabled={page === 1}
        onClick={() => changePage(page - 1)}>Previous</button>
      <button className="button small" aria-label="Next page" disabled={!hasMore}
        onClick={() => changePage(page + 1)}>Next</button>
    </div>
  </div>;
}

export function Status({ value }) {
  return <span className={`status status-${value.toLowerCase()}`}>{value.toLowerCase()}</span>;
}
