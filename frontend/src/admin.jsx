import React, { useRef, useState } from 'react';
import { amount, api, cost, currencies, formatDate, useResource } from './api.js';
import { Ledger, Notice, Pagination, Status } from './components.jsx';

const states = ['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const labels = { PROCESSING: 'Start processing', APPROVED: 'Approve withdrawal', REJECTED: 'Reject and refund' };

export function Admin() {
  const [token, setToken] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function signIn(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    const form = event.currentTarget;
    const key = new FormData(form).get('key').trim();
    form.reset();
    setBusy(true);
    setFailure('');
    try {
      const session = await api('/admin/session', key, { method: 'POST' });
      setToken(session.token);
    } catch (error) { setFailure(error.message); }
    finally { lock.current = false; setBusy(false); }
  }

  if (token) return <Dashboard token={token} signOut={() => setToken('')} />;
  return <section className="panel sign-in">
    <h1>Reviewer sign-in</h1>
    <p>Enter the reviewer access code to open the withdrawal queue and wallet ledger.</p>
    <form onSubmit={signIn}>
      <label>Access code<input name="key" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    {failure && <Notice error>{failure}</Notice>}
  </section>;
}

function Dashboard({ token, signOut }) {
  const [filter, setFilter] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [walletFilter, setWalletFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [review, setReview] = useState(null);
  const [walletId, setWalletId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const lock = useRef(false);
  const adjustment = useRef(null);
  const queue = useResource('/admin/withdrawals?page=' + page + '&limit=8' + (filter ? '&status=' + filter : ''), token, revision);
  const ledger = useResource('/admin/transactions?page=' + ledgerPage + '&limit=8' + (walletFilter ? '&userId=' + encodeURIComponent(walletFilter) : ''), token, revision);
  const expired = queue.error?.status === 403 || ledger.error?.status === 403 || message?.status === 403;

  async function mutate(action, onSuccess) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage({ text: onSuccess(result) });
      setRevision(value => value + 1);
    } catch (error) {
      setMessage({ text: error.message, error: true, status: error.status });
      if (error.status === 409) setRevision(value => value + 1);
    } finally { lock.current = false; setBusy(false); }
  }

  function submitReview(event) {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('reason')?.trim();
    if (review.status === 'REJECTED' && !reason) {
      setMessage({ text: 'Enter a reason for rejection.', error: true });
      return;
    }
    mutate(() => api('/admin/withdrawals/' + review.id, token, {
      method: 'PATCH', body: { status: review.status, ...(reason && { reason }) },
    }), ({ withdrawal }) => {
      setReview(null);
      return withdrawal.status === 'REJECTED' ? 'Withdrawal rejected. Wallet credits refunded.' : 'Withdrawal marked ' + withdrawal.status.toLowerCase() + '.';
    });
  }

  function submitAdjustment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const details = {
      currency: fields.get('currency'), type: fields.get('type'),
      amount: Number(fields.get('amount')), description: fields.get('description').trim(),
    };
    const owner = walletId.trim();
    if (!Number.isSafeInteger(details.amount) || details.amount < 1 || !details.description) {
      setMessage({ text: 'Enter a positive whole amount and a description.', error: true });
      return;
    }
    const fingerprint = JSON.stringify([owner, details]);
    if (adjustment.current && adjustment.current.fingerprint !== fingerprint) {
      setMessage({ text: 'Retry the previous adjustment with the same details before making changes.', error: true });
      return;
    }
    adjustment.current ??= { fingerprint, id: crypto.randomUUID() };
    mutate(async () => {
      try {
        return await api('/admin/wallet/' + owner + '/adjustments', token, {
          method: 'POST', body: { ...details, adjustmentId: adjustment.current.id },
        });
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 429) adjustment.current = null;
        throw error;
      }
    }, ({ entry }) => {
      adjustment.current = null;
      form.reset();
      setLedgerPage(1);
      setWalletFilter(owner);
      return 'Adjustment saved. Reference ' + entry._id;
    });
  }

  return <>
    <div className="page-head"><div><h1>Reviewer dashboard</h1><p>Review withdrawals and inspect wallet activity.</p></div>
      <button onClick={signOut}>Sign out</button></div>
    {message && <Notice error={message.error}>{message.text}</Notice>}
    {expired ? <Notice error>Reviewer session expired. Sign out and sign in again.</Notice> : <>
      <section className="panel" aria-busy={queue.loading}>
        <div className="section-head"><h2>Withdrawal queue</h2>
          <label className="inline-field">Status<select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
            <option value="">All statuses</option>{states.map(state => <option key={state} value={state}>{state.toLowerCase()}</option>)}
          </select></label>
        </div>
        {queue.error && <Notice error>{queue.error.message} <button onClick={() => setRevision(value => value + 1)}>Retry</button></Notice>}
        {queue.loading && <Notice>Loading withdrawal requests…</Notice>}
        {queue.data && <>
          {!queue.data.records.length && <p className="empty">No withdrawals match this status.</p>}
          <ul className="activity-list">{queue.data.records.map(item => <li key={item.id}>
            <div><strong>{amount(item)} via UPI</strong><small>{cost(item)} · {formatDate(item.createdAt)}</small>
              <small>Request <code>{item.id}</code></small><small>Wallet <code>{item.userId}</code></small>
              {item.rejectionReason && <small>{item.rejectionReason}</small>}</div>
            <div className="row-actions"><Status value={item.status} />
              {['PENDING', 'PROCESSING'].includes(item.status) && <>
                <button className="primary" disabled={busy} onClick={() => setReview({ id: item.id, status: item.status === 'PENDING' ? 'PROCESSING' : 'APPROVED' })}>
                  {labels[item.status === 'PENDING' ? 'PROCESSING' : 'APPROVED']}
                </button>
                <button disabled={busy} onClick={() => setReview({ id: item.id, status: 'REJECTED' })}>Reject</button>
              </>}
              <button disabled={busy} onClick={() => { setWalletId(item.userId); setWalletFilter(item.userId); setLedgerPage(1); }}>View wallet ledger</button>
            </div>
          </li>)}</ul>
          <Pagination data={queue.data} setPage={setPage} busy={queue.loading} />
        </>}
        {review && <form key={review.id + review.status} className="confirmation" onSubmit={submitReview}>
          <h3>{labels[review.status]}</h3>
          <p>Request <code>{review.id}</code></p>
          {review.status === 'REJECTED' && <label>Reason<textarea name="reason" required maxLength={200} /></label>}
          <div className="row-actions"><button type="button" disabled={busy} onClick={() => setReview(null)}>Cancel</button>
            <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</button></div>
        </form>}
      </section>
      <section className="panel" aria-busy={ledger.loading}>
        <div className="section-head"><h2>Wallet ledger</h2>
          {walletFilter && <button onClick={() => { setWalletFilter(''); setLedgerPage(1); }}>Show all wallets</button>}</div>
        {walletFilter && <p>Wallet <code>{walletFilter}</code></p>}
        {ledger.error && <Notice error>{ledger.error.message} <button onClick={() => setRevision(value => value + 1)}>Retry</button></Notice>}
        {ledger.loading && <Notice>Loading transactions…</Notice>}
        {ledger.data && <><Ledger admin records={ledger.data.records} /><Pagination data={ledger.data} setPage={setLedgerPage} busy={ledger.loading} /></>}
      </section>
      <section className="panel">
        <h2>Wallet adjustment</h2>
        <form onSubmit={submitAdjustment}>
          <fieldset disabled={busy}>
            <label>Wallet ID<input value={walletId} onChange={event => setWalletId(event.target.value)} pattern="[0-9a-fA-F]{24}" required /></label>
            <div className="form-grid">
              <label>Currency<select name="currency">{Object.entries(currencies).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
              <label>Type<select name="type"><option value="CREDIT">Credit</option><option value="DEBIT">Debit</option></select></label>
              <label>Amount<input name="amount" type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required /></label>
            </div>
            <label>Description<input name="description" required maxLength={200} /></label>
            <button className="primary">{busy ? 'Saving…' : 'Save adjustment'}</button>
          </fieldset>
        </form>
      </section>
    </>}
  </>;
}
