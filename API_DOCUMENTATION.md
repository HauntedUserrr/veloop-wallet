# Wallet API

Local base URL is `http://127.0.0.1:4001/api`. Demo mode uses sample credits. The signed token determines whose wallet and ledger are returned.

| Endpoint | Access | Request | Success |
| --- | --- | --- | --- |
| `GET /health` | Public | None | `200` with `status: "ready"` |
| `POST /auth/demo` | Demo mode | No body | `201` with a two-hour bearer token and demo user |
| `GET /wallet` | Bearer token | No query parameters | `200` with `wallet.balances` and `updatedAt` |
| `GET /wallet/transactions` | Bearer token | Optional `page` (1–500) and `limit` (1–50) | `200` with newest-first ledger `records`, `page`, `limit` and `hasMore` |
| `GET /payout/options` | Bearer token | None | `200` with available options, their costs and payout amounts in paise |
| `POST /withdrawals` | Bearer token | `Idempotency-Key` header and JSON body | `201` with the new pending withdrawal, or `200` when replaying the same request |
| `GET /withdrawals` | Bearer token | Optional `page` and `limit` | `200` with the caller’s withdrawal history |
| `GET /withdrawals/attempt` | Bearer token | Original `Idempotency-Key` | `200` with a committed receipt, or `404` when absent |
| `GET /withdrawals/:id` | Bearer token | Withdrawal ID | `200` with the caller’s withdrawal or `404` |
| `POST /admin/wallet/:userId/adjustments` | Reviewer bearer token | Stable `adjustmentId`, `type`, `currency`, integer `amount`, and `description` | `201` with the ledger entry, or `200` for an exact retry |
| `PATCH /admin/withdrawals/:id` | Reviewer bearer token | `status` and a `reason` for rejection or cancellation | `200` with the updated withdrawal |

## Review

Start a demo with `POST /api/auth/demo`. Keep the returned token local and use it in `Authorization: Bearer <token>` for the wallet requests. `GET /api/wallet` should return 25,000 VEs, 5,000 SVEs, 100 gems, 500 tokens and 3 spins. `GET /api/wallet/transactions?page=1&limit=5` should return five opening entries. Each entry records the source, amount and balance before and after the credit.

Missing or invalid authentication returns `401`. Invalid pagination returns `422`. Demo sign-in returns `404` when disabled and `429` when its rate limit is exceeded.

## Submit a payout

Fetch the catalog and choose `upi_100`. Send a new UUID as the `Idempotency-Key` header. Use the demo’s bearer token.

```json
{
  "optionId": "upi_100",
  "upiId": "review@sample",
  "quotedCost": 19500,
  "quotedAmountPaise": 10000
}
```

The server gets the debit and payout amounts from the catalog. Optional `quotedCost` and `quotedAmountPaise` check that the displayed quote is still current. After an interrupted response, check the original key before retrying the same request. A missing receipt can mean the first request is still in flight. The withdrawal should be `PENDING`, the wallet should have 5,500 VEs, and the ledger should contain a 19,500 VE debit linked to the withdrawal. Repeat the same body and key to verify a replay.

| Status | Example |
| --- | --- |
| `400` | Invalid JSON |
| `409` | Insufficient balance, changed quote, or reused key with changed details |
| `422` | Invalid option, UPI ID, body, or request key |
| `429` | Withdrawal rate limit exceeded |

With a configured reviewer token, send `{"status":"REJECTED","reason":"Demo review"}` to refund the exact debit once. To approve, move the withdrawal to `PROCESSING` first. Review changes and reversals are committed with their audit records.
