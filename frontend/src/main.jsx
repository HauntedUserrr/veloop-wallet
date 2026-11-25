import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin } from './admin.jsx';
import { amount, api, cost, count, currencies, formatDate, saved, useResource } from './api.js';
import { Ledger, Notice, Pagination, Status } from './components.jsx';
import './styles.css';

const sessionKey = 'veloop-rebuild-session';
const pendingKey = 'veloop-rebuild-withdrawal';
const route = location.pathname.replace(/\/$/, '') || '/wallet';
const upiPattern = /^[a-z0-9][a-z0-9._-]{1,127}@[a-z0-9][a-z0-9.-]{1,63}$/;

function Wallet({ session }) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const { data, loading, error } = useResource('/wallet/snapshot?page=' + page + '&limit=8', session.token, revision, true);
  return <>
    <div className="page-head"><div><h1>Your wallet</h1><p>Balances and transaction history</p></div>
      <button onClick={() => setRevision(value => value + 1)} disabled={loading}>Refresh</button></div>
    {error && <Notice error>{error.message}</Notice>}
    {loading && <Notice>Loading wallet…</Notice>}
    {data && <>
      <div className="wallet-grid">
        <section className="balance-card" aria-labelledby="available">
          <h2 id="available">Available rewards</h2>
          <p className="balance-value">{count.format(data.wallet.balances.ves)} <span>VEs</span></p>
          <a className="button primary" href="/payout">Withdraw rewards <span aria-hidden="true">→</span></a>
        </section>
        <section className="panel other-balances"><h2>Other balances</h2>
          <dl>{Object.entries(data.wallet.balances).filter(([code]) => code !== 'ves').map(([code, balance]) =>
            <div key={code}><dt>{currencies[code]}</dt><dd>{count.format(balance)}</dd></div>)}</dl>
        </section>
      </div>
      <section className="panel" aria-busy={loading}>
        <h2>Transaction history</h2>
        <Ledger records={data.history.records} />
        <Pagination data={data.history} setPage={setPage} busy={loading} />
        <details><summary>Wallet reference</summary><code>{session.user.id}</code></details>
      </section>
    </>}
  </>;
}

function Payout({ session }) {
  const [selection, setSelection] = useState('');
  const [upiId, setUpiId] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const storageKey = pendingKey + ':' + session.user.id;
  const [pending, setPending] = useState(() => saved(storageKey));
  const [receipt, setReceipt] = useState(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const snapshot = useResource('/wallet/snapshot?limit=1', session.token, revision, true);
  const catalog = useResource('/payout/options', session.token, revision);
  const option = pending?.option ?? catalog.data?.options.find(item => item.id === selection);
  const balance = option && snapshot.data?.wallet.balances[option.currency];
  const insufficient = option && balance < option.cost;
  const ready = snapshot.data && catalog.data && !snapshot.loading && !catalog.loading && !snapshot.error && !catalog.error;
  const refresh = () => setRevision(value => value + 1);

  function finish(withdrawal) {
    sessionStorage.removeItem(storageKey);
    setPending(null);
    setConfirmation(null);
    setReceipt(withdrawal);
    setSelection('');
    setUpiId('');
    refresh();
  }

  async function perform(action) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure('');
    try { await action(); }
    finally { lock.current = false; setBusy(false); }
  }

  function checkStatus() {
    perform(async () => {
      try {
        const result = await api('/withdrawals/attempt', session.token, { key: pending.key });
        finish(result.withdrawal);
      } catch (error) {
        setFailure(error.status === 404 ? 'No receipt yet. Retry using the original UPI ID.' : error.message);
      }
    });
  }

  function submit() {
    const attempt = pending ?? { key: crypto.randomUUID(), option: confirmation.option };
    perform(async () => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(attempt));
        const { withdrawal } = await api('/withdrawals', session.token, {
          method: 'POST', key: attempt.key,
          body: {
            optionId: attempt.option.id, upiId: confirmation.upiId,
            quotedCost: attempt.option.cost, quotedAmountPaise: attempt.option.amountPaise,
          },
        });
        finish(withdrawal);
      } catch (error) {
        if (pending || !error.status || error.status >= 500) setPending(attempt);
        else {
          sessionStorage.removeItem(storageKey);
          if ([409, 422].includes(error.status)) refresh();
        }
        setFailure(error.message);
        setConfirmation(null);
      }
    });
  }

  function confirm(event) {
    event.preventDefault();
    if (!option || (!pending && !ready)) return;
    const destination = upiId.trim().toLowerCase();
    if (!upiPattern.test(destination)) {
      setFailure('Enter a UPI ID in the form name@provider.');
      return;
    }
    setFailure('');
    setConfirmation({ option, upiId: destination });
  }

  const currentReceipt = snapshot.data?.withdrawals.records.find(item => item.id === receipt?.id) ?? receipt;
  return <>
    <div className="page-head"><div><h1>Withdraw rewards</h1><p>Simulated UPI payouts using demo credits.</p></div>
      <button onClick={refresh} disabled={snapshot.loading || catalog.loading}>Refresh</button></div>
    {failure && <Notice error>{failure}</Notice>}
    {(snapshot.error || catalog.error) && <Notice error>{(snapshot.error ?? catalog.error).message}</Notice>}
    {(snapshot.loading || catalog.loading) && <Notice>Refreshing the wallet and payout options…</Notice>}
    {currentReceipt && <Notice>{amount(currentReceipt)} withdrawal · {currentReceipt.status.toLowerCase()} · <code>{currentReceipt.id}</code></Notice>}
    {pending && <Notice>Confirmation is still unavailable. <button onClick={checkStatus} disabled={busy}>Check receipt</button></Notice>}
    <div className="payout-grid">
      <section className="panel">
        <h2>UPI withdrawal</h2>
        {(catalog.data || pending) && <form onSubmit={confirm}>
          <label>Payout amount<select value={pending?.option.id ?? selection} disabled={!!pending || busy || !!confirmation}
            required onChange={event => setSelection(event.target.value)}>
            <option value="">Select amount</option>
            {(catalog.data?.options ?? []).map(item => <option value={item.id} key={item.id}>{amount(item)} · {cost(item)}</option>)}
            {pending && !catalog.data?.options.some(item => item.id === pending.option.id) &&
              <option value={pending.option.id}>{amount(pending.option)} · {cost(pending.option)}</option>}
          </select></label>
          <label>UPI ID<input required value={upiId} disabled={busy || !!confirmation} spellCheck={false} autoCapitalize="none"
            autoComplete="off" maxLength={192} placeholder="name@provider" onChange={event => setUpiId(event.target.value)} /></label>
          <button type="button" disabled={busy || !!confirmation} onClick={() => setUpiId('review@sample')}>Use sample UPI ID</button>
          {balance !== undefined && option && <p className="field-note">Available {count.format(balance)} {currencies[option.currency]}</p>}
          {insufficient && !pending && <Notice error>Insufficient credits for this amount.</Notice>}
          <button className="primary" disabled={!option || !!confirmation || busy || (!pending && (!ready || insufficient))}>
            {pending ? 'Review retry' : 'Review withdrawal'}
          </button>
        </form>}
        {confirmation && <section className="confirmation" aria-label="Confirm withdrawal">
          <h3>Confirm withdrawal</h3>
          <p>Send {amount(confirmation.option)} to <strong>{confirmation.upiId}</strong> using {cost(confirmation.option)}.</p>
          <div className="row-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Confirm withdrawal'}</button></div>
        </section>}
      </section>
      <section className="panel"><h2>Recent withdrawals</h2>
        {snapshot.data && (snapshot.data.withdrawals.records.length ? <ul className="activity-list">
          {snapshot.data.withdrawals.records.map(item => <li key={item.id}>
            <div><strong>{amount(item)} via UPI</strong><small>{formatDate(item.createdAt)} · {cost(item)}</small>
              <small>Reference <code>{item.id}</code></small>
              {item.refundLedgerId && <small>Refunded · <code>{item.refundLedgerId}</code></small>}
              {item.rejectionReason && <small>{item.rejectionReason}</small>}</div>
            <Status value={item.status} />
          </li>)}</ul> : <p className="empty">No withdrawals yet.</p>)}
      </section>
    </div>
  </>;
}

function App() {
  const [session, setSession] = useState(() => saved(sessionKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);

  async function startDemo() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const user = await api('/auth/demo', null, { method: 'POST' });
      sessionStorage.setItem(sessionKey, JSON.stringify(user));
      setSession(user);
    } catch (failure) { setError(failure.message); }
    finally { lock.current = false; setBusy(false); }
  }

  function endDemo() {
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(pendingKey + ':' + session.user.id);
    setSession(null);
  }

  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className="topbar"><div className="shell topbar-content">
      <a className="brand" href="/wallet"><span className="brand-mark" aria-hidden="true">V</span> VELOOP <small>Rewards</small></a>
      <nav aria-label="Main navigation">
        <a href="/wallet" aria-current={route === '/wallet' ? 'page' : undefined}>Wallet</a>
        <a href="/payout" aria-current={route === '/payout' ? 'page' : undefined}>Withdraw</a>
        <a href="/admin" aria-current={route === '/admin' ? 'page' : undefined}>Reviewer</a>
      </nav>
      {session && route !== '/admin' && <button className="end-demo" onClick={endDemo}>End demo</button>}
    </div></header>
    <main id="main" className="shell">
      {route === '/admin' ? <Admin /> : session ? route === '/payout' ? <Payout session={session} /> : <Wallet session={session} /> :
        <section className="panel sign-in">
          <h1>Rewards wallet</h1>
          <p>Open a demo wallet with 25,000 VEs to view your ledger and try a UPI withdrawal.</p>
          <button className="primary" disabled={busy} onClick={startDemo}>{busy ? 'Opening wallet…' : 'Start demo'}</button>
          {busy && <p role="status">Connecting to the wallet API. It may take a minute to wake up.</p>}
          {error && <Notice error>{error}</Notice>}
        </section>}
    </main>
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
