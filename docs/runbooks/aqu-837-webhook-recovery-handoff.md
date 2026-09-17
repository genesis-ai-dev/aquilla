# AQU-837 webhook retry-recovery handoff

Date: 2026-09-10. Local verification only. Linear remains Dispatched.

## Integration identity

- Branch: `codex/aqu-837-webhook-recovery`
- Worktree: `/private/tmp/aquilla-aqu-837-webhook-recovery`
- Base: `194c894d4b6841aec5be10d0af79286f7fd0c512`
- Implementation commit: `b60edf860` (`fix(AQU-837): commit webhook receipts and application atomically`)
- The base is the primary worktree's committed HEAD at pickup. No primary
  reset, rebase, merge, checkout modification, or cherry-pick occurred.
- No marketing edits, deployment, real-secret installation, checkout activation,
  or Stripe settings changes occurred. Tests use synthetic signing secrets.

## Result and reproduction

The real HTTP handler accepts a signed subscription event. A Postgres trigger
observes the inserted receipt and rejects the projection write. At the base,
redelivery returns `{ ok: true, duplicate: true }` and leaves no subscription.
The initial PGlite regression fails on that exact response.

The fixed handler commits the receipt and projection in one transaction.
A failed application or commit leaves neither durable. Redelivery applies the
subscription. Successful duplicates return the existing duplicate response.
The same regression also passes against the local Postgres server through
`makePostgres`, using the production postgres.js adapter.

`applyBillingEvent` locks the organization row, inserts the receipt with
`ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`, applies effects through
the transaction handle, and awaits commit. The organization lock serializes
separate add-on events even before the billing projection exists. Stripe reads
happen before the transaction, so a network call does not hold the row lock.

Mutation reads and writes propagate database errors. Missing tables/columns no
longer masquerade as empty billing or successful application. Subscription
lookup failures return HTTP 500 rather than `ignored: no_org`. Handled events
without an event ID return HTTP 400 before any add-on effect.

## Changed files and dependencies

| File | Change |
| --- | --- |
| `auth-worker/src/routes/billing.ts` | Wrap all existing handled-event branches in atomic application; hydrate Stripe before locking; propagate lookup failures; require an event ID. |
| `auth-worker/src/lib/billing/apply.ts` | Replace receipt-only helper with atomic receipt/application; serialize webhook effects by organization; use strict mutation reads and writes. |
| `auth-worker/src/__tests__/billing-webhook-recovery.test.ts` | Signed HTTP-handler regressions against canonical Postgres schema. |
| `auth-worker/src/__tests__/billing-webhook-concurrency.postgres.ts` | Prove two live handler connections wait on the organization lock and apply one add-on. |
| `auth-worker/src/__tests__/helpers/webhook-postgres-setup.ts` | Create and remove a uniquely named local test database; load canonical schema; cap connection pool at four. |
| `auth-worker/vitest.webhook-postgres.config.ts` | Explicit local-server integration gate, one worker, 60-second test/hook watchdogs. |
| `docs/runbooks/aqu-837-webhook-recovery-handoff.md` | Integration evidence and limits; shared launch checklist stays untouched. |

No migration or shared schema change is required. Existing subscription snapshot
fields, plan/status mapping, and usage-period rules remain unchanged. Existing
`organizations`, `org_billing`, `org_billing_events`, their unique indexes, and
`AquillaDb.transaction` are required. Production already supplies transactions.
Missing schema now fails closed; apply the existing migrations before serving.

The primary agent should reconcile edits in `billing.ts` and `apply.ts` manually.
Every future entitlement/projection write for an event must use the callback's
`tx` handle. Do not use the outer database handle, start nested transactions,
or launch detached work from the callback. No schema/entitlement extension is
included or approved by this slice.

## Tests actually run

Commands below run from the isolated worktree root unless stated otherwise.

| Command | Result |
| --- | --- |
| `pnpm --dir auth-worker exec vitest run src/__tests__/billing-webhook-recovery.test.ts --maxWorkers=2` before the fix | Expected failure: retry is falsely classified as duplicate. |
| Same single regression after the fix | 1 passed. |
| `pnpm --dir auth-worker exec vitest run src/__tests__/billing-webhook-recovery.test.ts src/__tests__/billing-routes.test.ts src/__tests__/admin-billing.test.ts src/__tests__/billing-plans.test.ts --maxWorkers=2` | 48 passed across four files. |
| `pnpm --dir auth-worker exec vitest run --config vitest.webhook-postgres.config.ts` | 14 passed across two files on local Postgres, one worker. |
| `pnpm --dir auth-worker exec tsc --noEmit` | Passed after correcting test types and installing the existing sync-worker dependencies. |
| `npm run build` | Passed: IDML gate, `tsc -b`, Vite, app-output and brand checks. |
| `pnpm exec vitest run scripts/e2e-determinism.test.ts scripts/e2e-impact.test.ts --maxWorkers=2` | 24 passed. |
| `E2E_SHARD=37/38 npx tsx scripts/e2e-up.ts -- e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1 --workers=1` | First attempt blocked at Chromium launch by the macOS sandbox. Host-permitted execution passed, 1 test. |
| `git diff --check` | Passed. |

An intermediate worker invocation included the nonexistent base-path
`billing-entitlements.test.ts`; Vitest selected only the other three files
(33 tests passed). The final four-file command above uses existing files.
The initial TypeScript run found test typing errors and missing sync-worker
packages; those were resolved before the passing check. No assertions were
removed, skipped, weakened, or retried into a pass.

The live-server gate uses unique `aqu_837_webhook_<uuid>` databases and removes
them after each file. Its default is local port 5432 with the repository's dev
credentials. `WEBHOOK_TEST_PG_URL` can override that local connection; remote
hosts are rejected. The local role needs permission to create databases.

The browser gate uses `aquilla_e2e_s36`, identity port 13387, sync port 13388,
and Vite port 9773. `--shard=1/1` runs the full selected spec despite the isolated
stack numbering. The permitted run has no worker `[slow-request]` or `EMFILE`
logs. The failed sandbox run also logged a file-watcher `EMFILE` warning.

## Exact shared checklist evidence

From `stripe-go-live.md`, under **Signed events → durable workspace access**:

- **Supported in full locally:** “Make event application and deduplication
  recoverable together. Test a failure after receipt recording, then redelivery
  of the same Stripe event.” The trigger regression and deferred-constraint
  commit failure both prove rollback and successful redelivery.
- **Partial evidence only:** “Test valid, invalid, and missing signatures using
  the configured event payload shape. Local unsigned bypass does not verify
  Stripe signatures.” These tests use configured synthetic HMAC secrets,
  current item-based period fields, and both invoice subscription shapes.
  They exercise valid, invalid, and missing signatures through the real handler.
  No actual sandbox destination delivery was performed.
- **Partial evidence only:** “Test duplicate and out-of-order events,
  simultaneous delivery, and an invoice arriving before subscription-to-workspace
  mapping exists.” Duplicate and simultaneous delivery pass. The server test
  observes two blocked connections before releasing the lock. Distinct add-ons
  accumulate correctly. Out-of-order and missing-mapping reconciliation remain open.
- **Partial evidence only:** “Preserve legacy and covered access through
  subscription updates and replay. Reject events whose subscription/customer
  mapping conflicts with the workspace.” Existing checkout, cancellation,
  add-on, admin override, and billing UI tests pass. Regression coverage preserves
  hard caps, complimentary words when no rollover occurs, and an unrelated
  covered organization's exact row. A customer-uniqueness conflict returns 500
  without a receipt. Full same-workspace mapping/covered-access policy is not
  implemented here; do not mark this whole item complete.

Additional reliability evidence: unavailable receipt/projection tables,
subscription lookup failure, unrelated uniqueness failure, commit-time failure,
and Stripe retrieval failure never produce a successful processing response.
The checkout and both invoice shapes recover after a Stripe read failure.

No production launch checklist item becomes fully complete from this slice.
The primary agent owns reconciliation of the shared checklist.

## Test-impact analysis

Changed contract: a verified event receives successful processing acknowledgement
only after its receipt and applicable legacy projection effects commit together.
Producers are signed checkout, subscription update/delete, and invoice payloads.
Consumers are the billing route, Stripe subscription parser/client, atomic event
helper, subscription/add-on helpers, and the production Postgres adapter.

The new handler tests pass real signed payloads through those consumers into
canonical Postgres tables. Database triggers and deferred constraints inject
failures inside the persistence boundary. The live-server test proves concurrent
lock contention that PGlite's single connection cannot establish.

The existing billing smoke still exercises auth → billing API → UI and covered
access inquiry behavior; this slice changes no labels or controls. It needs no
selector or assertion changes. Handler failure injection belongs in the new
Postgres tests. The existing billing sentinel in `scripts/lib/e2e-impact.ts`
already selects the billing smoke for both changed production paths.

## Remaining risks and decisions

- Historical receipts written by the old handler cannot distinguish successful
  application from failed application. This fix protects new processing attempts;
  it does not automatically replay old receipts. Reconcile historical events
  against Stripe before considering targeted repair, especially legacy add-ons.
- Out-of-order distinct events can still overwrite newer subscription state.
  No ordering/versioning policy is introduced.
- An invoice without a subscription mapping still returns the existing ignored
  response. A database lookup failure now returns 500, but absent mapping is a
  separate reconciliation policy for the primary agent.
- Existing no-Stripe-configuration fallback/no-op paths remain compatible.
  Synthetic local success does not establish readiness of a configured sandbox.
- Configured checkout/invoice duplicates hydrate Stripe before checking the
  committed receipt. A Stripe outage can therefore return 500 for an already
  applied event; retry remains safe and cannot duplicate database effects.
- The organization lock coordinates webhook writers. Concurrent admin changes
  do not yet participate in that lock protocol. Integration must assess other
  writers before claiming universal subscription concurrency guarantees.
- The existing covered-access runbook explicitly says later webhooks can update
  an administratively overridden plan. This slice preserves that behavior;
  stronger protection needs the primary agent's mapping/entitlement decisions.
- Same-period timestamp comparison and legacy rollover rules remain as they were.
  This slice does not redesign allowance resets or repair older projection rules.
- Real Stripe sandbox checkout/webhook/portal verification, full release smoke,
  production configuration, and deployment remain outstanding.

Specification review: `aquilla-specs/04-features/billing-and-tiers.md`, especially
**Stripe integration (future)**, **Invariants (future)**, and **Non-functional
notes (future)**, still describes older projection tables. No sibling-spec file
was edited from this isolated slice. The primary agent should add this regression
rule during its existing reconciliation: “A handled Stripe event's successful
acknowledgement requires its deduplication receipt and database effects to commit
atomically. Failed attempts remain retryable; duplicate delivery cannot repeat
an effect.” Keep billing policy changes separate from that reliability rule.

## Dev PR preparation — 2026-09-10

The requested PR targets `dev`. The original branch includes the primary agent's
unmerged billing foundation, so opening it directly would include 44 files.
We preserve that branch and create a separate integration branch:

- Branch: `codex/aqu-837-webhook-recovery-dev`
- Worktree: `/private/tmp/aquilla-aqu-837-webhook-recovery-dev`
- Dev base: `f151dd271589fb1cff73c9db8bca7615df01f205`
- Implementation cherry-pick: `1694d412f`
- Original handoff cherry-pick: `b5d4e6555`

Both commits apply without conflicts. The dev PR changes only the seven files
listed above. No primary-agent catalog, schema, pricing, entitlement, metering,
or UI commits are included. Original base and implementation identities remain
recorded above for coordination.

On this exact dev base, the same four-file worker command passes 44 tests;
14 live Postgres tests and worker TypeScript also pass. The original branch's
four additional catalog-route tests are not present on dev. Initial test imports
failed while root dependencies were still installing; after installation,
verification passes without source or assertion changes.

The earlier billing-sentinel statement describes the original primary-derived
base. This dev base has its own affected-E2E selection rules; its actual pre-push
selection and production build results are recorded in the PR test checklist.
Linear remains Dispatched. The PR does not authorize merge or deployment.
