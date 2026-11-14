# Recurring Payment Agent Design

## Understanding

- Upgrade this project to satisfy the Recurring Payment Agent task and provide a verifiable public demo.
- Use Cloudflare Workers for the API and static UI, D1 for durable state, and a one-minute Cron trigger.
- Support weekly/monthly payment schedules with amount, token, sender, recipient, time zone, next payment, and history.
- Prepare unsigned transactions for users to review and sign with an external wallet.
- Never store private keys, sign transactions, or broadcast transactions from the server.
- Verify chain data and transaction receipts before reporting a payment as paid.
- Treat Cron as best effort; report lateness and never claim an absolute exactly-once guarantee.

## Assumptions

- Initial usage is a low-volume public demo; reliability and honest evidence matter more than throughput.
- The target network is Pharos Mainnet, chain ID 1672, matching the reference repository.
- Schedule details are private to a workspace; public evidence uses synthetic data or explicitly public read-only records.
- Cloudflare credentials and publication access may be required for deployment; deployment is not considered complete until verified.
- A live paid example is not required and must never be fabricated.

## Decision log

1. **Unsigned-only payment flow.** No server keys, signing, approvals, or broadcast endpoint. This follows the reference security boundary and avoids custodial risk.
2. **Workers, D1, and Cron.** Use the reference platform so due schedules are processed while the browser is closed and state survives Worker restarts.
3. **Pharos Mainnet (1672).** Use the mainnet target explicitly selected by the user; validate chain identity on all live chain operations.
4. **Calendar-based recurrence.** Use an IANA time zone, preserve monthly anchor days, clamp unavailable month days, and keep schedule revisions immutable for existing occurrences.
5. **Persistent idempotent occurrences.** Uniquely identify each schedule/revision/time occurrence, conditionally claim work, and enforce unique transaction hashes in D1.
6. **Fail closed.** Missing or inconsistent chain evidence blocks preparation or reconciliation; only a verified successful receipt becomes `PAID`.
7. **Honest publication evidence.** Clearly distinguish simulated data, live validation, prepared unsigned transactions, and verified paid transactions.

## Architecture

- A Cloudflare Worker serves the static dashboard and same-origin JSON API.
- D1 stores workspace capability hashes, schedule revisions, immutable occurrences, validation/review evidence, unsigned transaction data, transaction hashes, reconciliation results, and Cron heartbeat data.
- A Cron trigger runs every minute. It creates due occurrences using deterministic calendar rules, caps catch-up at 12 occurrences per schedule per run, conditionally claims pending work, and retries receipt reconciliation for submitted transactions.
- A Pharos chain adapter performs read-only checks: chain ID, sender and token balances, token bytecode/metadata, call simulation, gas estimate, and receipt/transaction reads. Chain-service errors or malformed evidence never produce a success state.
- The UI displays schedule terms, next local/UTC due time, scheduler heartbeat/lateness, occurrence status/history, validation evidence, and unsigned transaction export.
- Users sign outside the service and submit a transaction hash for independent reconciliation. Cron and the dashboard reconcile receipts; the app does not broadcast.

## Schedule and occurrence behavior

- Weekly recurrence means every seven calendar days at the configured local wall-clock time.
- Monthly recurrence preserves the original day anchor; dates beyond a month's length clamp to its last day and return to the anchor in later months.
- Time-zone DST gaps move forward and overlaps choose the earlier instant (`compatible` disambiguation).
- Editing a schedule creates a new revision; existing occurrences retain their original terms. Pause/resume affects future preparation.
- Occurrences progress through `PENDING`, `VALIDATING`, `READY_FOR_REVIEW`, `PREPARED_UNSIGNED`, `AWAITING_CONFIRMATION`, and terminal outcomes such as `PAID`, `BLOCKED_INSUFFICIENT_FUNDS`, `VALIDATION_FAILED`, or `FAILED_ONCHAIN`.
- Ambiguous submissions remain unresolved and prevent replacement exports until reconciled. Hash association alone never marks an occurrence paid.
- The configured Mainnet USDC address (`0xc879c018db60520f4355c26ed1a6d572cdac1815`) returned contract bytecode and 6 decimals from the Pharos MCP on 2026-11-14. Custom ERC-20 assets require contract-code and metadata checks.

## Security and privacy

- Every workspace API operation is scoped to an unguessable capability; only its hash is persisted.
- The browser receives a secure, same-origin session mechanism; requests are protected against cross-site access.
- Amounts are represented as exact decimal strings and converted to base units without floating-point arithmetic.
- The server has no signing credentials. Unsigned exports disclose all transaction fields, chain ID, and validation time.
- Schedule data and wallet addresses are treated as sensitive public metadata; demo fixtures use synthetic values.

## Verification and release

- Unit and integration tests cover recurrence/time zones, validation boundaries, workspace isolation, conditional claims, duplicate Cron runs, insufficient funds, RPC/MCP failure, receipt mismatch/revert, automatic reconciliation, and duplicate hashes.
- A production build and D1 migration are required before deployment.
- Deployment verification checks the public UI/API, mainnet chain identity, Cron heartbeat, and a genuine prepared occurrence.
- Publication links must point to a reachable demo and repository. Evidence must not imply a transaction was paid unless a matching successful receipt was independently verified.

## Known limitations

- Cloudflare Cron is best effort; lateness is observable but cannot be eliminated.
- Independent externally signed transfers do not provide contract-enforced exactly-once execution.
- Mainnet RPC/MCP availability and token behavior are external dependencies.
- “100% ready” cannot be guaranteed in advance; readiness means all task criteria are implemented, validations pass, and the deployed proof is verified.
