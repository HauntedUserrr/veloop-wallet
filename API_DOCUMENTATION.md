# Wallet API

Base URL for local use is `http://127.0.0.1:4000/api`. Send JSON bodies with `Content-Type: application/json`. Protected endpoints require `Authorization: Bearer <token>`. User tokens expire after two hours and admin tokens after 30 minutes. The signed role must match the current database role.

## Endpoints

| Method and path | Access | Request | Success response |
| --- | --- | --- | --- |
| `GET /health` | Public | None | `200` with `status: "ready"` |
| `GET /auth/demo` | Public | None | `200` with availability of `publicDemo` and `evaluatorAccess` |
| `POST /auth/demo` | Public when enabled | Empty JSON object | `201` with `token` and `user`. Creates an isolated demo wallet. |
| `POST /auth/demo/evaluator` | Evaluator access code when configured | `accessCode` | `201` with a demo token and user from the evaluator pool |
| `POST /auth/login` | Public | `email`, `password` | `200` with `token` and `user` |
| `POST /auth/logout` | Signed in | None | `200` and revokes the account's current tokens |
| `GET /wallet` | Signed in | No query parameters | `200` with `wallet.balances` and `wallet.updatedAt` |
| `GET /wallet/summary` | Signed in | Pagination, default limit 5 | `200` with `wallet`, `recentTransactions`, and `pagination` from the same database snapshot |
| `GET /wallet/transactions` | Signed in | Pagination | `200` with `records` and `pagination` |
| `POST /wallet/credit` | Admin | Adjustment body | `201` with `transaction` |
| `POST /wallet/debit` | Admin | Adjustment body | `201` with `transaction` |
| `POST /wallet/exchange` | Admin | Exchange body | `201` with `debit` and `credit` |
| `GET /payout/methods` | Signed in | None | `200` with `methods` without denomination lists |
| `GET /payout/options` | Signed in | None | `200` with the methods and the caller's available options |
| `GET /payout/options/:method` | Signed in | Method slug, such as `upi` | `200` with `method` and its `options` |
| `POST /withdrawals/intents` | Signed in | Withdrawal body and `Idempotency-Key` header | `200` with `prepared: true`. Binds the quote and destination without debiting. |
| `DELETE /withdrawals/intents` | Signed in | Original `Idempotency-Key` header | `200` with `abandoned: true`, or `abandoned: false` and the committed withdrawal |
| `POST /withdrawals` | Signed in | Withdrawal body and `Idempotency-Key` header | `201` for a new withdrawal, `200` with `replayed: true` for the matching retry |
| `GET /withdrawals` | Signed in | Pagination | `200` with the caller's `records` and `pagination` |
| `GET /withdrawals/attempt` | Signed in | Original `Idempotency-Key` header | `200` with the caller's committed `withdrawal`, or `404` if none is visible |
| `GET /withdrawals/:id` | Signed in | Withdrawal ID | `200` with the caller's `withdrawal` |
| `GET /admin/withdrawals` | Admin | Pagination, optional `status` and `userId` filters | `200` with `records` and `pagination` |
| `GET /admin/withdrawals/:id` | Admin | Withdrawal ID | `200` with `withdrawal` |
| `GET /admin/withdrawals/:id/audit` | Admin | Withdrawal ID | `200` with chronological `history`, including reviewer notes where recorded |
| `PATCH /admin/withdrawals/:id` | Admin | `status`, optional `note`, required `reason` for rejection or cancellation | `200` with the updated `withdrawal` |
| `GET /admin/wallet/:userId/transactions` | Admin | User ID and pagination | `200` with `records` and `pagination` |
| `GET /admin/wallet/:userId/reconciliation` | Admin | User ID | `200` with `reconciliation`, comparing balances with posted ledger entries |
| `POST /admin/payout/options` | Admin | Option ID, existing method ID, charge currency and amount, INR denomination, optional `active` | `201` with `option` |
| `PATCH /admin/payout/options/:id` | Admin | One or more of `active`, `requiredAmount`, `payoutMinor` | `200` with `option` |
| `PATCH /admin/payout/methods/:id` | Admin | One or more of `active`, `regions`, `detailType`, `detailLabel` | `200` with `method` |

Paginated responses are newest first and include `pagination: { page, limit, hasMore }`. The default is page 1, limit 20. The API accepts pages 1–500 and limits 1–50. Ledger records include `_id`, `userId`, `currency`, `type`, `amount`, `balanceBefore`, `balanceAfter`, `source`, `referenceId`, `status`, `description`, and `createdAt`.

## Wallet example

```http
GET /api/wallet
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "wallet": {
    "balances": { "ves": 25000, "sves": 5000, "gems": 100, "tokens": 500, "spins": 3 },
    "updatedAt": "2026-11-21T12:00:00.000Z"
  }
}
```

## Submit a withdrawal

Select an eligible method and option from the catalog. Send its IDs, the required destination, and the quote the user confirmed. The server looks up the debit and payout amounts, and rejects a stale quote. Payouts use integer paise, so `10000` represents ₹100.

```http
POST /api/withdrawals
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: 83ef9af6-6aad-496a-8ffd-a4b48ffdf413

{
  "method": "upi",
  "optionId": "upi_100",
  "payoutDetail": "demo@sample",
  "expectedRequiredAmount": 19500,
  "expectedPayoutMinor": 10000
}
```

```json
{
  "success": true,
  "replayed": false,
  "withdrawal": {
    "id": "673f22ceae544060df117a91",
    "userId": "673f22ceae544060df117a8b",
    "method": "upi",
    "methodName": "UPI",
    "optionId": "upi_100",
    "currency": "ves",
    "currencyAmount": 19500,
    "payoutMinor": 10000,
    "payoutCurrency": "INR",
    "status": "PENDING",
    "transactionId": "673f22ceae544060df117a92",
    "requestedAt": "2026-11-21T12:00:00.000Z",
    "updatedAt": "2026-11-21T12:00:00.000Z"
  }
}
```

Use a UUID per intended submission. Direct API callers can send the example request as written. The browser uses a key of the form `wd1-<Unix timestamp in milliseconds>-<UUID>` and must prepare that key with the same body before it can submit a debit. Prepared browser keys accept submissions for 125 minutes from their timestamp, with up to five minutes of future clock tolerance.

After an uncertain response, look up the receipt with the original key. A `404` can mean the debit is still in flight. Retry only with the same key and original body, or discard the intent. A confirmed discard prevents that browser key from debiting later. A discard that lost the race to a committed debit returns the original withdrawal. Withdrawal responses omit destination details.

## Admin mutation examples

Credit or debit with this shape. Valid credit sources include `REWARD`, `BONUS`, `REFERRAL`, `DAILY_REWARD`, `AD_REWARD`, `GAME_REWARD`, `ADMIN_CREDIT`, and `CORRECTION`. Debit sources are `ADMIN_DEBIT` and `CORRECTION`. Use a stable internal reference per operation.

```json
{
  "userId": "673f22ceae544060df117a8b",
  "currency": "ves",
  "amount": 500,
  "description": "Demo credit",
  "referenceId": "demo-credit-1",
  "source": "ADMIN_CREDIT"
}
```

For an exchange, send `userId`, `fromCurrency`, `fromAmount`, `toCurrency`, `toAmount`, `referenceId`, and `description`. The administrator supplies the trusted conversion amounts. Both legs post in one transaction.

To reject the withdrawal, send `{"status":"REJECTED","reason":"Demo review"}` to the admin review endpoint. This returns funds through a separate credit. `CANCELLED` also reverses the debit. The service checks current customer and payout method eligibility when entering `PROCESSING` and `APPROVED`.

## Review and reconcile

The withdrawal timeline shows the actor, action, previous status, new status, and timestamp for each recorded transition. It includes the reviewer note, rejection reason, and refund transaction ID when available. Reviewer notes are available to administrators. Customers can see the rejection reason on their own withdrawal.

Wallet reconciliation compares each stored currency balance with posted credits minus posted debits in a single database snapshot. It returns `balanced` and the `currencies` report. Amounts are decimal strings. The `difference` is the stored balance minus the ledger balance. Here is an example VE result after a ₹100 redemption.

```json
{
  "credits": "25000",
  "debits": "19500",
  "entries": 5,
  "expected": "5500",
  "actual": "5500",
  "difference": "0"
}
```

If a difference is present, the endpoint responds with `balanced: false` for investigation. The report leaves the wallet and ledger as recorded.

## Configure payouts

1. Confirm the denomination, required credits, region rules, and destination field from the current platform.
2. Add the tier using `POST /admin/payout/options`. Include `id`, `method`, `currency`, `requiredAmount`, and `payoutMinor`. The option starts inactive unless the request includes `"active": true`.
3. Verify or activate the tier through `PATCH /admin/payout/options/:id`. Then enable its method using `PATCH /admin/payout/methods/:id`. A method needs at least one active option. Supply allowed two-letter region codes and the confirmed destination field. The current field types are `UPI_ID` and `EMAIL`.

Wallet clients discover changes on the next catalog fetch. If the charge or denomination changes after a user opens the confirmation, the server returns `QUOTE_CHANGED` and no debit posts. Effective configuration changes produce an audit record.

## Error contract

```json
{
  "success": false,
  "code": "INSUFFICIENT_BALANCE",
  "message": "Insufficient VES balance."
}
```

| Status | Representative error codes |
| --- | --- |
| `400` | `UNEXPECTED_QUERY`, `INVALID_BODY` |
| `401` | `AUTH_REQUIRED`, `INVALID_CREDENTIALS`, `INVALID_EVALUATOR_CODE` |
| `403` | `FORBIDDEN`, `INELIGIBLE`, `ACCOUNT_REVIEW`, `ACCOUNT_SUSPENDED`, `ORIGIN_NOT_ALLOWED` |
| `404` | `WITHDRAWAL_NOT_FOUND`, `METHOD_NOT_FOUND`, `USER_NOT_FOUND`, `CATALOG_ITEM_NOT_FOUND` |
| `409` | `INSUFFICIENT_BALANCE`, `BALANCE_LIMIT`, `QUOTE_CHANGED`, `IDEMPOTENCY_CONFLICT`, `INTENT_REQUIRED`, `INTENT_EXPIRED`, `INTENT_ABANDONED`, `INVALID_TRANSITION`, `DUPLICATE_REFERENCE`, `METHOD_HAS_NO_OPTIONS`, `OPTION_EXISTS` |
| `413` | `INVALID_BODY` |
| `422` | `VALIDATION_ERROR`, `METHOD_UNAVAILABLE`, `OPTION_UNAVAILABLE`, `INVALID_DETAILS`, `INTENT_KEY_INVALID` |
| `429` | `RATE_LIMITED` |
| `500` / `503` | `INTERNAL_ERROR`, `DATABASE_UNAVAILABLE`, `DEMO_CAPACITY` |

Import the [Postman collection](docs/VELoop-Wallet.postman_collection.json) for runnable examples.
