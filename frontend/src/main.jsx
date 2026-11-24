import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const currency = { ves: 'VEs', sves: 'SVEs', gems: 'Gems', tokens: 'Tokens', spins: 'Spins' };
const count = new Intl.NumberFormat('en-IN');
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const formatDate = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const base = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const sessionKey = 'veloop-rebuild-session';
const pendingKey = 'veloop-rebuild-withdrawal';
const payout = location.pathname === '/payout';

function saved(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); }
  catch { return null; }
}

async function api(path, token, { body, key, method = 'GET' } = {}) {
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method, signal: AbortSignal.timeout(20_000),
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
        ...(key && { 'Idempotency-Key': key }),
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the wallet API.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw Object.assign(new Error(data?.error ?? 'The wallet API returned an error.'), { status: response.status });
  return data;
}

function Wallet({ token }) {
  const [page, setPage] = useState(1);
  const [ledger, setLedger] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api('/wallet', token), api(`/wallet/transactions?page=${page}&limit=6`, token)])
      .then(([data, history]) => { if (active) { setWallet(data.wallet); setLedger(history); } })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [page, token]);

  return <>
    <h1>Wallet</h1>
    {error && <p role="alert">{error}</p>}
    {!wallet && !error && <p role="status">Loading wallet…</p>}
    {wallet && <dl className="balances">
      {Object.entries(wallet.balances).map(([code, balance]) =>
        <div key={code}><dt>{currency[code]}</dt><dd>{count.format(balance)}</dd></div>)}
    </dl>}
    <a className="primary button" href="/payout">Redeem rewards</a>
    <h2>Transaction history</h2>
    {ledger && <>
      <table><thead><tr><th>Transaction</th><th>Change</th></tr></thead>
        <tbody>{ledger.records.map(item => <tr key={item._id}>
          <td>{item.description}<small>{formatDate.format(new Date(item.createdAt))}</small></td>
          <td>{item.type === 'DEBIT' ? '−' : '+'}{count.format(item.amount)} {currency[item.currency]}</td>
        </tr>)}</tbody>
      </table>
      <div className="pagination">
        <button disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page}</span>
        <button disabled={!ledger.hasMore} onClick={() => setPage(value => value + 1)}>Next</button>
      </div>
    </>}
  </>;
}

function Payout({ token }) {
  const [data, setData] = useState(null);
  const [selection, setSelection] = useState('');
  const [upiId, setUpiId] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [pending, setPending] = useState(() => saved(pendingKey));
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([api('/wallet', token), api('/payout/options', token), api('/withdrawals?limit=5', token)])
      .then(([wallet, options, history]) => {
        if (active) setData({ balances: wallet.wallet.balances, options: options.options, history: history.records });
      }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [token, revision]);

  const chosen = data?.options.find(option => option.id === (pending?.option.id ?? selection));
  const option = pending?.option ?? chosen;
  const balance = option && data?.balances[option.currency];
  const insufficient = option && balance < option.cost;
  const amount = item => money.format(item.amountPaise / 100);
  const cost = item => `${count.format(item.cost)} ${currency[item.currency]}`;

  function finish(withdrawal) {
    sessionStorage.removeItem(pendingKey);
    setPending(null);
    setConfirmation(null);
    setReceipt(withdrawal);
    setSelection('');
    setUpiId('');
    refresh(value => value + 1);
  }

  async function checkStatus() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/withdrawals/attempt', token, { key: pending.key });
      finish(result.withdrawal);
    } catch (failure) {
      setError(failure.status === 404 ? 'No receipt yet. Retry with the original UPI ID.' : failure.message);
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true);
    setError('');
    const attempt = pending ?? { key: crypto.randomUUID(), option: confirmation.option };
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(attempt));
      const result = await api('/withdrawals', token, {
        method: 'POST', key: attempt.key,
        body: {
          optionId: attempt.option.id, upiId: confirmation.upiId,
          quotedCost: attempt.option.cost, quotedAmountPaise: attempt.option.amountPaise,
        },
      });
      finish(result.withdrawal);
    } catch (failure) {
      const uncertain = pending || !failure.status || failure.status >= 500;
      if (uncertain) setPending(attempt);
      else {
        sessionStorage.removeItem(pendingKey);
        if ([409, 422].includes(failure.status)) refresh(value => value + 1);
      }
      setError(failure.message);
      setConfirmation(null);
    } finally { setBusy(false); }
  }

  return <>
    <h1>Payout</h1>
    <p>Simulated UPI withdrawal. Use a sample UPI ID.</p>
    {error && <p role="alert">{error}</p>}
    {receipt && <p role="status">{amount(receipt)} withdrawal · {receipt.status.toLowerCase()} <a href="/wallet">View wallet</a></p>}
    {pending && <p>Withdrawal receipt pending. <button onClick={checkStatus} disabled={busy}>Check status</button></p>}
    {!data && !error && <p role="status">Loading payout options…</p>}
    {data && <>
      <form onSubmit={event => {
        event.preventDefault();
        setError('');
        setConfirmation({ option, upiId: upiId.trim().toLowerCase() });
      }}>
        <label>Payout amount
          <select required value={pending?.option.id ?? selection} disabled={!!pending || busy}
            onChange={event => setSelection(event.target.value)}>
            <option value="">Select amount</option>
            {data.options.map(item => <option value={item.id} key={item.id}>{amount(item)} · {cost(item)}</option>)}
          </select>
        </label>
        {option && <>
          <label>UPI ID<input required value={upiId} spellCheck={false} autoComplete="off" maxLength={192}
            onChange={event => setUpiId(event.target.value)} /></label>
          <button type="button" onClick={() => setUpiId('review@sample')}>Use sample UPI ID</button>
          <p>Available: {count.format(balance)} {currency[option.currency]}</p>
        </>}
        {insufficient && !pending && <p>Insufficient credits for this amount.</p>}
        <button className="primary" disabled={!option || !!confirmation || busy || (!pending && insufficient)}>
          {pending ? 'Review retry' : 'Review withdrawal'}
        </button>
      </form>
      {confirmation && <section className="confirmation" aria-label="Confirm withdrawal">
        <h2>Confirm withdrawal</h2>
        <p>{amount(confirmation.option)} to {confirmation.upiId}. Deduct {cost(confirmation.option)}.</p>
        <button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>{' '}
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Confirm redemption'}</button>
      </section>}
      <h2>Recent withdrawals</h2>
      {data.history.length ? <ul>{data.history.map(item =>
        <li key={item.id}>{amount(item)} · {item.status.toLowerCase()}</li>)}</ul> : <p>No withdrawals yet.</p>}
    </>}
  </>;
}

function App() {
  const [session, setSession] = useState(() => saved(sessionKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startDemo() {
    setBusy(true);
    setError('');
    try {
      const user = await api('/auth/demo', null, { method: 'POST' });
      sessionStorage.setItem(sessionKey, JSON.stringify(user));
      setSession(user);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <main>
    <header>
      <strong>VELoop Rewards</strong>
      {session && <nav aria-label="Wallet navigation"><a href="/wallet">Wallet</a> <a href="/payout">Payout</a> <button onClick={() => {
        sessionStorage.removeItem(sessionKey);
        sessionStorage.removeItem(pendingKey);
        setSession(null);
      }}>End demo</button></nav>}
    </header>
    {session ? payout ? <Payout token={session.token} /> : <Wallet token={session.token} /> : <>
      <h1>Demo wallet</h1>
      <button className="primary" disabled={busy} onClick={startDemo}>{busy ? 'Starting…' : 'Start demo'}</button>
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
