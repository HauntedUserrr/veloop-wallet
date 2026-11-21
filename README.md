# VELoop Rewards Wallet & Payout

Start a demo wallet, inspect its ledger, and submit a simulated UPI withdrawal. Each demo session starts with 25,000 VEs.

## Stack

React and CSS with Vite, Node.js and Express, MongoDB with Mongoose, and JWT authentication.

## Run locally

Use Node.js 22.12+ and npm. If you are starting from GitHub, copy the repository’s HTTPS URL from **Code**, run `git clone <repository-url>`, and open the clone. For an existing checkout, start at its root.

1. From the repository root, run `npm ci`.
2. Copy `.env.example` to `.env`. Run the two commands below and put their outputs in `JWT_SECRET` and `PAYOUT_ENCRYPTION_KEY`, in that order.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Run `npm run mongo:local` in a separate terminal. It downloads MongoDB 8.0.12 on first run and stores data in `.mongo/`. For an existing development database, set `MONGO_URI` to your MongoDB replica set or sharded cluster.
4. Run `npm run seed` to create the payout options. For administrator access, set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of at least 16 characters before seeding.
5. Run `npm run dev`. Vite serves the app on port 5173 and proxies API calls to port 4000. [Open the wallet](http://localhost:5173)

## Demo and verification

- Test sign-in, a withdrawal, and administrator decisions. [Demo walkthrough](docs/DEMONSTRATION.md)
- Inspect the endpoints or run their Postman requests. [API reference](API_DOCUMENTATION.md) · [Postman collection](docs/VELoop-Wallet.postman_collection.json)
- Review the schemas, accounting, and security controls. [Architecture](docs/ARCHITECTURE.md)
- Run `npm test` against an isolated MongoDB replica set and `npm run build` to build the frontend. [Test results](docs/TEST_RESULTS.md)

The demo uses the UPI tiers in the assignment. PayPal and gift-card methods require confirmed prices and destination fields before activation. [Payout configuration](API_DOCUMENTATION.md#configure-payouts)

## Sandbox access and maintenance

- For restricted evaluator sign-in, set a private `EVALUATOR_ACCESS_CODE` of at least 24 characters and share it with evaluators. The evaluator pool can be used when `DEMO_ENABLED=false`.
- To rotate an administrator password, supply `ADMIN_EMAIL` and `ADMIN_NEW_PASSWORD` through the environment and run `npm run admin:rotate-password`. Rotation revokes that account’s sessions.
- Preview old demo accounts with `npm run demo:cleanup -- --days 7 --limit 250`. Add `--apply` to delete the batch from the sandbox database.

## Hosting

- Use a separate MongoDB Atlas database with TLS and an application-specific database user.
- From the repository root on Render or Railway, install with `npm ci --omit=dev --workspace backend` and start with `npm start`. Set the database URI and secrets from `.env.example`, `API_HOST=0.0.0.0`, the frontend HTTPS origin in `CLIENT_ORIGINS`, and the appropriate `TRUST_PROXY_HOPS` for the host. Choose public or evaluator demo access, run `npm run seed`, and use `/api/health` for health checks.
- Build the `frontend` workspace with `npm run build` and publish its `dist` directory on Vercel or Netlify. Set `VITE_API_URL` to the API origin without `/api`. Check that a direct visit to `/payout` works.

## Scaling from 1,000 to 1,000,000 users

- Partition by wallet owner as load grows. Choose shard keys and compound indexes that preserve per-user uniqueness. Keep conditional balance changes and ledger entries in the same transaction. Use cursor pagination for long histories.
- Write an outbox event in the withdrawal transaction and process it through a durable payout queue. Carry the idempotency key to the provider. Bound retries and reconcile provider outcomes before settling uncertain requests.
- Cache the payout catalog, apply rate limits at a shared gateway, and use risk checks to route unusual withdrawals to review. Encrypt destinations with managed, versioned keys.
- Reconcile wallet balances against ledger totals. Monitor transaction conflicts, queue age, and payout discrepancies. Keep audit records and test recovery from backups.
