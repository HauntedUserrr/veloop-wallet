# Wallet API

Local base URL is `http://127.0.0.1:4001/api`. Demo mode uses sample credits. The signed token determines whose wallet and ledger are returned.

| Endpoint | Access | Request | Success |
| --- | --- | --- | --- |
| `GET /health` | Public | None | `200` with `status: "ready"` |
| `POST /auth/demo` | Demo mode | No body | `201` with a two-hour bearer token and demo user |
| `GET /wallet` | Bearer token | No query parameters | `200` with `wallet.balances` and `updatedAt` |
| `GET /wallet/transactions` | Bearer token | Optional `page` (1–500) and `limit` (1–50) | `200` with newest-first ledger `records`, `page`, `limit` and `hasMore` |

## Review

Start a demo with `POST /api/auth/demo`. Keep the returned token local and use it in `Authorization: Bearer <token>` for the wallet requests. `GET /api/wallet` should return 25,000 VEs, 5,000 SVEs, 100 gems, 500 tokens and 3 spins. `GET /api/wallet/transactions?page=1&limit=5` should return five opening entries. Each entry records the source, amount and balance before and after the credit.

Missing or invalid authentication returns `401`. Invalid pagination returns `422`. Demo sign-in returns `404` when disabled and `429` when its rate limit is exceeded.
