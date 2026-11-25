import React from 'react';
import { count, currencies, formatDate } from './api.js';

export function Status({ value }) {
  return <span className={'status status-' + value.toLowerCase()}>{value.toLowerCase()}</span>;
}

export function Notice({ error, children }) {
  return <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : 'status'}>{children}</p>;
}

export function Pagination({ data, setPage, busy }) {
  return <div className="pagination">
    <button disabled={busy || data.page === 1} onClick={() => setPage(data.page - 1)}>Previous</button>
    <span>Page {data.page}</span>
    <button disabled={busy || !data.hasMore} onClick={() => setPage(data.page + 1)}>Next</button>
  </div>;
}

export function Ledger({ records, admin = false }) {
  if (!records.length) return <p className="empty">No transactions to show.</p>;
  return <div className="table-wrap"><table>
    <thead><tr><th scope="col">Transaction</th><th scope="col">Amount</th><th scope="col">Date</th>
      <th scope="col">Status</th><th scope="col">Reference</th>{admin && <th scope="col">Wallet</th>}</tr></thead>
    <tbody>{records.map(item => <tr key={item._id}>
      <td data-label="Transaction"><strong>{item.description}</strong><small>{item.type === 'DEBIT' ? 'Debit' : 'Credit'}</small></td>
      <td data-label="Amount" className="numeric">{item.type === 'DEBIT' ? '−' : '+'}{count.format(item.amount)} {currencies[item.currency]}</td>
      <td data-label="Date"><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></td>
      <td data-label="Status"><Status value={item.status ?? 'POSTED'} /></td>
      <td data-label="Reference"><code>{item._id}</code></td>
      {admin && <td data-label="Wallet"><code>{item.userId}</code></td>}
    </tr>)}</tbody>
  </table></div>;
}
