import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Balance, currencyNames, ErrorMessage, formatDate, Loading, number, Pagination, Status, useApi } from './components.jsx';

export default function Wallet({ token }) {
  const [page, setPage] = useState(1);
  const summary = useApi(token, `/wallet/summary?page=${page}&limit=6`);
  const snapshot = summary.data;

  return <>
    <div className="page-head">
      <h1>Wallet</h1>
      <button className="button" onClick={summary.reload}>Refresh</button>
    </div>
    <ErrorMessage error={summary.error} retry={summary.reload} />
    <section className="panel balances-panel" aria-labelledby="balance-heading">
      <div className="panel-head">
        <h2 id="balance-heading">Available balances</h2>
        <Link className="button primary" to="/payout">Redeem rewards</Link>
      </div>
      {snapshot
        ? <dl className="balances">
            {Object.keys(currencyNames).map(currency =>
              <Balance key={currency} currency={currency} value={snapshot.wallet.balances[currency]} />)}
          </dl>
        : !summary.error && <Loading />}
    </section>
    <section className="panel" aria-labelledby="activity-heading">
      <div className="panel-head">
        <h2 id="activity-heading">Transaction history</h2>
      </div>
      {snapshot && <>
        {snapshot.recentTransactions.length ? <table className="ledger" aria-labelledby="activity-heading">
          <thead>
            <tr><th scope="col">Transaction</th><th scope="col">Change</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            {snapshot.recentTransactions.map(item => <tr key={item._id}>
              <td className="activity-info">
                <strong>{item.description}</strong>
                <small><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></small>
              </td>
              <td className="ledger-amount">
                {item.type === 'CREDIT' ? '+' : '−'}{number.format(item.amount)} {currencyNames[item.currency]}
              </td>
              <td><Status value={item.status} /></td>
            </tr>)}
          </tbody>
        </table> : <p className="empty">No transactions on this page.</p>}
        {(page > 1 || snapshot.pagination.hasMore) &&
          <Pagination page={snapshot.pagination.page} hasMore={snapshot.pagination.hasMore} changePage={setPage} />}
      </>}
    </section>
  </>;
}
