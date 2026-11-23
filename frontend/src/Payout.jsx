import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  abandonAttempt, completedWithdrawal, forgetAttempt, savedAttempts, shouldReloadCatalog, submitWithdrawal,
} from './withdrawals.js';
import {
  currencyNames, ErrorMessage, formatDate, Loading, money, number, Pagination, Status, useApi,
} from './components.jsx';

const sampleDestinations = {
  UPI_ID: { value: 'demo@sample', action: 'Use sample UPI ID' },
  EMAIL: { value: 'demo@example.test', action: 'Use sample email' },
};
const emptySelection = { method: '', option: '', detail: '' };

function credits(amount, currency) {
  return `${number.format(amount)} ${currencyNames[currency]}`;
}

function Confirmation({ attempt, busy, error, close, submit }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal() }, []);
  const editRequired = error?.status >= 400 && error.status < 500 && error.status !== 429;
  const retry = attempt.retry || (!!error && !editRequired);
  const { currency, requiredAmount } = attempt.option;
  return <dialog ref={dialog} aria-labelledby="confirm-heading" aria-describedby="confirm-details" onCancel={event => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <h2 id="confirm-heading">{retry ? 'Retry withdrawal' : 'Confirm redemption'}</h2>
    {retry ? <p id="confirm-details">Retry with the original amount and destination.</p> : <dl id="confirm-details" className="quote confirm-quote">
      <div><dt>Payout</dt><dd>{attempt.method.name} · {money(attempt.option)}</dd></div>
      <div><dt>Credits to deduct</dt><dd>{credits(requiredAmount, currency)}</dd></div>
      <div><dt>{attempt.method.detailLabel}</dt><dd>{attempt.body.payoutDetail}</dd></div>
    </dl>}
    <ErrorMessage error={error} />
    <div className="buttons">
      <button className="button" type="button" autoFocus disabled={busy} onClick={close}>
        {editRequired ? 'Back to payout details' : 'Cancel'}
      </button>
      {!editRequired && <button className="button primary" type="button" disabled={busy} onClick={submit}>
        {busy ? 'Submitting…' : retry ? 'Retry withdrawal' : 'Confirm redemption'}
      </button>}
    </div>
  </dialog>;
}

export default function Payout({ token, userId, isDemo }) {
  const [selection, setSelection] = useState(emptySelection);
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState(null);
  const [recoveryFeedback, setRecoveryFeedback] = useState(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const pending = useRef(false);
  const catalog = useApi(token, '/payout/options');
  const balance = useApi(token, '/wallet', revision);
  const history = useApi(token, `/withdrawals?page=${page}&limit=5`, revision);
  const receiptDetails = useApi(token, receipt && `/withdrawals/${receipt.id}`, revision);
  const methods = catalog.data?.methods ?? [];
  const availableMethods = methods.filter(item => item.eligible && item.options.length > 0);
  const method = availableMethods.find(item => item.id === selection.method);
  const option = method?.options.find(item => item.id === selection.option);
  const sample = sampleDestinations[method?.detailType];
  const available = option ? balance.data?.wallet.balances[option.currency] : undefined;
  const storagePrefix = `veloop:withdrawal:${userId}:`;
  const attempts = savedAttempts(storagePrefix);
  const storageKey = option && `${storagePrefix}${option.id}`;
  const retryKey = attempts.find(attempt => attempt.storageKey === storageKey)?.key;
  const blockedByEarlierAttempt = !retryKey && attempts.length > 0;
  const insufficient = option && !retryKey && available !== undefined && available < option.requiredAmount;
  const canReview = option && selection.detail.trim() && !busy && !blockedByEarlierAttempt && !insufficient
    && (available !== undefined || !!retryKey);
  const currentReceipt = receiptDetails.data?.withdrawal ?? receipt;

  function confirm(event) {
    event.preventDefault();
    if (!canReview) return;
    const body = {
      method: method.id, optionId: option.id, payoutDetail: selection.detail.trim().toLowerCase(),
      expectedRequiredAmount: option.requiredAmount, expectedPayoutMinor: option.payoutMinor,
    };
    setError(null);
    setConfirmation({
      method, option, body, storageKey, retry: !!retryKey,
      key: retryKey ?? `wd1-${Date.now()}-${crypto.randomUUID()}`,
    });
  }

  function showReceipt(withdrawal, attempt) {
    forgetAttempt(attempt);
    setSelection(emptySelection);
    setReceipt(withdrawal);
    setConfirmation(null);
    setRecoveryFeedback(null);
    setPage(1);
    setRevision(value => value + 1);
  }

  async function runAction(action) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      pending.current = false;
    }
  }

  function reviewAttempt(attempt, discard) {
    return runAction(async () => {
      setRecoveryFeedback(null);
      try {
        if (discard) {
          const result = await abandonAttempt(token, attempt);
          if (result.withdrawal) {
            showReceipt(result.withdrawal, attempt);
          } else if (result.abandoned) {
            forgetAttempt(attempt);
            setRecoveryFeedback('Withdrawal attempt discarded.');
          }
          return;
        }
        const withdrawal = await completedWithdrawal(token, attempt);
        if (withdrawal) showReceipt(withdrawal, attempt);
        else setRecoveryFeedback('No receipt yet. Retry with the original details or discard the attempt.');
      } catch (error) {
        setRecoveryFeedback(error);
      }
    });
  }

  function submit() {
    return runAction(async () => {
      const attempt = confirmation;
      setError(null);
      setRecoveryFeedback(null);
      try {
        showReceipt(await submitWithdrawal(token, attempt), attempt);
      } catch (error) {
        if (shouldReloadCatalog(error)) catalog.reload();
        if (error.code === 'INSUFFICIENT_BALANCE') balance.reload();
        setError(error);
      }
    });
  }

  return <>
    <div className="page-head">
      <div>
        <h1>Redeem rewards</h1>
        {isDemo && <p>Simulated payout. Use sample details.</p>}
      </div>
      <Link className="button" to="/wallet">Back to wallet</Link>
    </div>
    {currentReceipt && <div className="message success" role="status">
      <span>{money(currentReceipt)} withdrawal · {currentReceipt.status.toLowerCase()}</span>
      <Link to="/wallet">View wallet</Link>
    </div>}
    <ErrorMessage error={receiptDetails.error} retry={receiptDetails.reload} />
    {typeof recoveryFeedback === 'string'
      ? <p className="attempt-notice" role="status">{recoveryFeedback}</p>
      : <ErrorMessage error={recoveryFeedback} />}
    {attempts.map(attempt => {
      const payoutMethod = methods.find(item => item.options.some(tier => tier.id === attempt.optionId));
      const tier = payoutMethod?.options.find(item => item.id === attempt.optionId);
      return <section key={attempt.storageKey} className="panel pending-attempt" aria-label="Unresolved withdrawal">
        <div>
          <h2>Unresolved withdrawal</h2>
          {tier && <p>{payoutMethod.name} · {money(tier)}</p>}
        </div>
        <div className="buttons">
          <button type="button" className="button" disabled={busy} onClick={() => reviewAttempt(attempt, false)}>
            Check status
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => reviewAttempt(attempt, true)}>
            Discard attempt
          </button>
        </div>
      </section>;
    })}
    <div className="payout-layout">
      <section className="panel" aria-label="Payout details">
        <ErrorMessage error={catalog.error} retry={catalog.reload} />
        <ErrorMessage error={balance.error} retry={balance.reload} />
        {!catalog.data && !catalog.error && <Loading />}
        {catalog.data && <form className="payout-form" onSubmit={confirm}>
          <fieldset>
            <legend>Payout method</legend>
            <div className="methods">
              {availableMethods.map(item =>
                <label key={item.id} className="choice">
                  <input type="radio" name="method" value={item.id}
                    checked={selection.method === item.id}
                    onChange={() => setSelection({ method: item.id, option: '', detail: '' })} />
                  <span>{item.name}</span>
                </label>)}
            </div>
            {!availableMethods.length && <p>No payout methods are available for this account.</p>}
          </fieldset>
          {method && <>
            <div className="field">
              <label htmlFor="payout-option">Payout amount</label>
              <select id="payout-option" required value={selection.option}
                onChange={event => setSelection(current => ({ ...current, option: event.target.value }))}>
                <option value="">Choose an amount</option>
                {method.options.map(item => <option value={item.id} key={item.id}>
                  {money(item)} · {number.format(item.requiredAmount)} {currencyNames[item.currency]}
                </option>)}
              </select>
            </div>
            {option && <div className="field">
              <label htmlFor="payout-detail">{method.detailLabel}</label>
              <div className="destination">
                <input id="payout-detail" type={method.detailType === 'EMAIL' ? 'email' : 'text'}
                  autoComplete="off" autoCapitalize="none" spellCheck="false" required maxLength={254}
                  placeholder={isDemo ? sample?.value : undefined}
                  value={selection.detail}
                  onChange={event => setSelection(current => ({ ...current, detail: event.target.value }))} />
                {isDemo && sample && <button className="button sample-button" type="button"
                  onClick={() => setSelection(current => ({ ...current, detail: sample.value }))}>
                  {sample.action}
                </button>}
              </div>
            </div>}
            {option && <dl className="quote" aria-label="Payout costs">
              <div><dt>Available</dt><dd>{available === undefined ? '—' : credits(available, option.currency)}</dd></div>
              <div><dt>Required</dt><dd>{credits(option.requiredAmount, option.currency)}</dd></div>
            </dl>}
            {insufficient && <p className="field-error" role="status">
              Choose a lower amount. This payout requires more {currencyNames[option.currency]} than you have.
            </p>}
            {retryKey && <p>Re-enter the payout details to retry your earlier withdrawal.</p>}
          </>}
          {blockedByEarlierAttempt && <p>Resolve the earlier withdrawal before starting another.</p>}
          <button className="button primary" type="submit"
            disabled={!canReview}>
            {retryKey ? 'Review previous submission' : 'Review withdrawal'}
          </button>
        </form>}
      </section>
      <section className="panel" aria-labelledby="withdrawal-history">
        <div className="panel-head">
          <h2 id="withdrawal-history">Withdrawals</h2>
          <button className="button" type="button" onClick={() => setRevision(value => value + 1)}>
            Refresh withdrawals
          </button>
        </div>
        <ErrorMessage error={history.error} retry={history.reload} />
        {!history.data && !history.error && <Loading />}
        {history.data && <>
          {history.data.records.length > 0 ? <ul className="activity-list">
            {history.data.records.map(item => <li key={item.id} className="activity">
              <div className="activity-info">
                <strong>{item.methodName} · {money(item)}</strong>
                <small>{number.format(item.currencyAmount)} {currencyNames[item.currency]} {item.refundTransactionId ? 'returned' : 'deducted'}</small>
                <small>{formatDate(item.requestedAt)}</small>
                {item.rejectionReason && <small>{item.rejectionReason}</small>}
              </div>
              <Status value={item.status} />
            </li>)}
          </ul> : <p className="empty">{page === 1 ? 'No withdrawals yet.' : 'No withdrawals on this page.'}</p>}
          {(page > 1 || history.data.pagination.hasMore) &&
            <Pagination page={page} hasMore={history.data.pagination.hasMore} changePage={setPage} />}
        </>}
      </section>
    </div>
    {confirmation && <Confirmation attempt={confirmation} busy={busy} error={error}
      close={() => setConfirmation(null)} submit={submit} />}
  </>;
}
