import { useEffect, useState } from 'react';

const base = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const currencies = { ves: 'VEs', sves: 'SVEs', gems: 'Gems', tokens: 'Tokens', spins: 'Spins' };
export const count = new Intl.NumberFormat('en-IN');
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = date => dates.format(new Date(date));
export const amount = item => money.format(item.amountPaise / 100);
export const cost = item => count.format(item.cost) + ' ' + currencies[item.currency];

export function saved(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); }
  catch { return null; }
}

export async function api(path, token, { body, key, method = 'GET', signal } = {}) {
  let response;
  try {
    const timeout = AbortSignal.timeout(70_000);
    response = await fetch(base + '/api' + path, {
      method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        ...(token && { Authorization: 'Bearer ' + token }),
        ...(body && { 'Content-Type': 'application/json' }),
        ...(key && { 'Idempotency-Key': key }),
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error('The wallet API could not be reached. Try again shortly.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(data?.error ?? 'The wallet API returned an error.'), { status: response.status });
  }
  return data;
}

export function useResource(path, token, revision = 0, poll = false) {
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!path || !token) return;
    let active = true;
    let inflight;
    async function load() {
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      try {
        const data = await api(path, token, { signal: controller.signal });
        if (active && !controller.signal.aborted) setResult({ path, token, revision, data });
      } catch (error) {
        if (active && !controller.signal.aborted) {
          setResult(previous => ({
            path, token, revision, error,
            data: previous?.path === path && previous.token === token ? previous.data : null,
          }));
        }
      } finally {
        if (inflight === controller) inflight = undefined;
      }
    }
    function visible() {
      if (!document.hidden && !inflight) load();
    }
    load();
    const timer = poll ? setInterval(visible, 12_000) : undefined;
    if (poll) window.addEventListener('focus', visible);
    return () => {
      active = false;
      inflight?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', visible);
    };
  }, [path, token, revision, poll]);

  return result?.path === path && result.token === token
    ? { ...result, loading: result.revision !== revision }
    : { loading: true };
}
