# VELoop Rewards wallet

This is the fresh implementation of the internship assignment. The first review covers the Node.js, Express and MongoDB wallet API. Demo sign-in creates an independent wallet and posts its starting credits to the ledger in the same transaction.

## Run the API

1. Install dependencies with `npm ci` on Node.js 22.12 or later.
2. Copy `.env.example` to `.env`. Generate a local token key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and set `JWT_SECRET`.
3. Run `npm run mongo:local` in one terminal and `npm run dev` in another. The local database uses port 27018 and the API uses port 4001.

See the [API reference](API_DOCUMENTATION.md) for the review walkthrough. Run `npm test` to check opening balances, owner-scoped history, pagination and transaction rollback against an isolated MongoDB replica set.

## Next implementation step

Add the server-controlled payout catalog and a transactional withdrawal that debits the wallet, records the ledger entry and stores a pending request. The React wallet and payout pages will use those endpoints.
