# Test results

`npm test` passed 31 API integration tests on Windows with Supertest and an isolated MongoDB 8.0.12 replica set. The suite seeds its own payout fixtures. `npm run build` produced the frontend bundle.

| Assignment scenario | Verified result |
| --- | --- |
| Credit | 1,000 + 500 = 1,500 VEs, with a ledger entry and audit event. |
| Withdrawal | 1,500 − 1,000 = 500 VEs. The withdrawal is pending. |
| Insufficient funds | A 1,000 VE withdrawal from 500 VEs creates no withdrawal or debit. |
| Duplicate request | Concurrent requests with the same idempotency key return the same withdrawal ID and post one debit. |
| Concurrent withdrawals | Of two 8,000 VE requests against 10,000 VEs, one succeeds and the balance ends at 2,000 VEs. |
| Invalid payout option | Unknown tiers, inactive methods, and invalid destinations are rejected. |
| Unauthorized access | Anonymous wallet requests, access to another user's withdrawal, and user attempts to credit a wallet are rejected. |
| Reversal | Repeated rejection posts one reversal and one rejection audit event. |
| Price tampering | Extra amount fields and changed quotes are rejected. Accepted requests use catalog prices. |

The remaining tests cover transaction rollback, refund headroom, exchange deduplication, consistent pagination, sign-out and role changes across API instances, password rotation, CORS, shared rate limits, catalog changes, approval eligibility, receipt ownership, safe retry and discard, evaluator access, demo cleanup, review history, and exact ledger reconciliation. [Integration suite](../backend/test/wallet.test.js)

## Browser verification

- The final build passed Edge checks at 320px and 1366px. The sign-in screen showed only the configured access option, and the payout form showed only eligible methods. Earlier checks also covered keyboard confirmation, insufficient balance, pagination, and sign-out.
- The ₹100 walkthrough posted a 19,500 VE debit, showed a pending receipt, and left 5,500 VEs. Approval kept that balance. Rejection restored 25,000 VEs and showed the recorded reason.
- Interrupted submissions recovered the committed receipt after reload. A retry with changed details failed, and discarding an uncommitted request prevented a later debit.
- After the layout change, the production build passed at 320px and 1366px. The ledger table fit the viewport, pagination worked, and a ₹100 withdrawal posted the debit and refreshed the balance.
