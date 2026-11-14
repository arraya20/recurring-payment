# Recurring Payment Agent

A Cloudflare Worker app for scheduling weekly or monthly Pharos Mainnet payments. Cron creates due occurrences, records read-only balance/gas validation, and retries transaction-receipt reconciliation. Users review and sign exported unsigned transactions in a wallet they control; the service never stores keys, signs, or broadcasts.

**Network:** Pharos Mainnet, chain ID `1672`

**USDC:** `0xc879c018db60520f4355c26ed1a6d572cdac1815` (6 decimals; contract code and decimals verified through the Pharos MCP on 2026-11-14)

## Requirements

- Node.js `24.22.0` (see `.nvmrc`)
- npm
- Cloudflare account and the `cf` CLI for deployment

The project uses Cloudflare's `cf` configuration and Vite plugin v2 beta. The CLI/plugin integration is in beta.

## Test and run locally

```bash
npm ci
npm test
cf d1 migrations apply 00000000-0000-4000-8000-000000000001 --local
npm run dev
```

Open the local URL printed by `cf dev`. Local D1 state is persisted under `.cloudflare/state`.

## Build and publish

Create a D1 database named `recurring-payment-agent` in your Cloudflare account and record its database ID. Then:

```bash
cf auth login
export CLOUDFLARE_D1_DATABASE_ID="<database-id>"
cf d1 migrations apply "$CLOUDFLARE_D1_DATABASE_ID" --mode production
npm run build
npm run deploy
```

`npm run deploy -- --dry-run` builds and checks the deployment without publishing. Production requires the D1 database ID and Cloudflare credentials; neither is committed to this project.

## Payment lifecycle

1. A due schedule is recorded as a unique occurrence and checked against the configured chain.
2. The user reviews the immutable payment terms and downloads an unsigned transaction.
3. The user signs and submits it outside this service, then attaches its transaction hash.
4. Cron and the dashboard check the transaction and receipt. Only a matching successful receipt with the required confirmations is marked `PAID`.

Cron is best effort, not an exact-time execution guarantee. A prepared unsigned transaction remains usable outside the app even if its schedule is paused. No sample or simulated payment is presented as paid.

## Submission

- [Pharos Recurring Payment Agent task](https://pharos-agent-arena.vercel.app/tasks/recurring-payment-agent)
- A public demo and verified deployment must be added after Cloudflare deployment; this repository does not claim either is live.
