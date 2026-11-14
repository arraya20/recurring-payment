# Skill: recurring-payment-agent

**Target:** Pharos Mainnet, chain ID `1672`

**Category:** Recurring payments

## Description

Create and track weekly or monthly payment schedules. The Cloudflare Worker checks due payments and validates balances, gas, and transaction receipts. It is unsigned-only: the service never stores wallet keys, signs, or broadcasts transactions. A user must review and sign each exported transaction in an external wallet.

## Capabilities

1. Create, revise, pause, resume, and list payment schedules.
2. Track each due occurrence and its validation, review, and transaction status.
3. Export an unsigned transaction after successful validation and explicit review.
4. Reconcile an externally submitted transaction hash. A hash alone is never proof of payment.

## Payment status

- `READY_FOR_REVIEW`: chain checks passed; the user must review the terms.
- `PREPARED_UNSIGNED`: an unsigned transaction was exported; no payment was sent.
- `AWAITING_CONFIRMATION`: a transaction is visible but not yet confirmed.
- `PAID`: the transaction and successful receipt match the scheduled terms.
- `BLOCKED_INSUFFICIENT_FUNDS`, `VALIDATION_FAILED`, `FAILED_ONCHAIN`, or `RECONCILIATION_REQUIRED`: action or investigation is needed.
