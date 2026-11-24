# VELoop Rewards wallet

The wallet API uses Node.js, Express and MongoDB. Demo sign-in creates a wallet with 25,000 VEs and records the opening credits in its ledger. A withdrawal uses the database catalog and commits the debit, ledger entry and pending request in one transaction.

## Run locally

1. Install dependencies with `npm ci` on Node.js 22.12 or later.
2. Copy `.env.example` to `.env`. Run `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` twice and put the separate values in `JWT_SECRET` and `PAYOUT_ENCRYPTION_KEY`.
3. Run `npm run mongo:local` in one terminal and `npm run dev` in another. The local database uses port 27018 and the API uses port 4001.

4. For the React demo, run `npm run dev:frontend` in a third terminal and open [the wallet](http://localhost:5173/wallet). Sign in with **Start demo**, then open **Payout** and select the ₹100 tier.

For API review, follow the [API walkthrough](API_DOCUMENTATION.md) or import the [Postman collection](VELOOP.postman_collection.json). A ₹100 sample UPI withdrawal deducts 19,500 VEs, leaves 5,500 VEs, and appears as pending. Repeating the request with the same key returns the original withdrawal.

Run `npm test` against an isolated MongoDB replica set. All 18 integration tests cover concurrent withdrawals, changed quotes, duplicate keys, owner-scoped reads, refunds, protected adjustments, and rollback after failed writes. Run `npm run build` to build the React demo.

The catalog starts with the assignment’s sample UPI tiers. Use sample destinations such as `review@sample`. Approval and rejection are simulated.

## Host the API

Use a separate MongoDB Atlas database. On Render, use `npm ci --omit=dev` as the build command and `npm start` as the start command. Set `HOST=0.0.0.0`, the Atlas connection string, separate secret keys, and `DEMO_ENABLED=true` in the service environment. Use `/api/health` as its health check. Set a separate `REVIEWER_TOKEN` only if review endpoints are needed. Configure `TRUST_PROXY_HOPS` for the service’s verified proxy path before enabling public demo traffic.

On Vercel, select the `frontend` workspace, use the Vite preset, and set `VITE_API_URL` to the Render service origin. Set `CLIENT_ORIGIN` on Render to the exact frontend origin.
