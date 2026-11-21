const base = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const sessionEvents = new EventTarget();

export function onSessionExpired(handler) {
  sessionEvents.addEventListener('expired', handler);
  return () => sessionEvents.removeEventListener('expired', handler);
}

export async function request(path, { token, body, headers, signal, method = 'GET' } = {}) {
  const timeout = AbortSignal.timeout(20_000);
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not reach the wallet API. Please try again.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    if (token && (response.status === 401 || data?.code === 'ACCOUNT_SUSPENDED')) {
      sessionEvents.dispatchEvent(new CustomEvent('expired', { detail: token }));
    }
    throw Object.assign(new Error(data?.message ?? 'The wallet API returned an unexpected response.'), {
      status: response.status,
      code: data?.code,
    });
  }
  return data;
}
