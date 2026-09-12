# Stripe launch and covered-access playbook

Updated: 2026-09-10. Tickets: AQU-837 (billing readiness), AQU-1091 (pricing and app UI).

## Latest launch decisions: weekly usage and Pro AI tools

This section supersedes older monthly-allowance implementation notes below.
Monthly/annual Stripe prices do not change. Weekly capacity is the prior monthly
reference divided by four, with full resets every seven days, no rollover, and
no extra reset at invoice renewal. Continuous weekly periods yield about 52
allocations annually; do not implement a 28-day billing cycle. Five-hour
throttling remains a future option, disabled now.

Pro unlocks advanced AI tools: in-app agent, AI-assisted briefs, suggested checks
from edit patterns, and tokens for external-agent integrations. Max inherits all
Pro features and increases capacity only. Team inherits these tools in its shared
workspace. Credit units stay internal; app and marketing show weekly percentages,
reset dates, and relative capacity.

Remaining implementation after the foundation update below:
apply weekly metering across actual AI execution paths; enforce workspace feature
capabilities and token permissions server-side; update app controls and marketing
copy. Test feature access, ownership isolation, shared usage across tools, reset
boundaries, concurrent consumption, and renewals that do not reset weekly usage.
Earlier passing monthly tests do not verify deployed weekly enforcement.
No production entitlement or reset behavior changed yet.

## Active parallel work — 2026-09-10

Primary worktree: `/private/tmp/aquilla-aqu-837`, base `194c894d4`.
Workspace slice committed as `9b1240273`.
The primary slice owns explicit workspace billing scope, eligibility, initial
paid entitlement storage, and the workspace summary in billing settings.
It adds `billing-workspace.ts` routes and `workspace*.ts` billing services;
it does not change webhook receipt/application or `billing.ts`.
Migration `0092_workspace_billing.sql` is reserved for this slice.

The parallel agent completes webhook retry recovery in a separate worktree.
Its implementation and evidence are integrated as `4275e43e5` and `96ec91a6a`.
Handoff: `docs/runbooks/aqu-837-webhook-recovery-handoff.md`.
The primary agent integrates verified commits and maintains this checklist.
Do not mark payment journeys complete from either slice's isolated tests.

- [x] Verify new personal/team creation → persisted scope → billing eligibility.
- [x] Verify initial approved offer → entitlement persistence → workspace reads.
- [x] Verify replay, subscription uniqueness, and project ownership isolation.
- [x] Verify billing settings explain the target and preserve covered access.
- [x] Checkpoint this slice with test evidence and reconcile the behavior spec.
  Specification commit: `cdf1ef9`; implementation commit contains this record.

## Workspace implementation evidence — 2026-09-10

New lazy personal workspaces persist `personal`; named workspace creation
persists `team`. Existing workspaces retain an unconfirmed scope until reviewed.
Names and member counts do not silently reclassify existing organizations.
The authenticated workspace summary checks maintainer authority and excludes
existing billing, agreed allowances, partner coverage, and unreviewed personal
collaboration from new purchases. Project ownership selects the workspace;
a member's personal plan is never a fallback.

The internal initial-entitlement writer validates an approved quote and stores
its subscription, customer, versions, interval, and original weekly anchor.
Transactions serialize activation; exact replay preserves the anchor and
conflicting subscription assignments fail. No public route grants a plan.
Migration `0092_workspace_billing.sql` is prepared, not deployed. Checkout,
webhook-to-new-entitlement wiring, lifecycle changes, and actual weekly metering
remain incomplete. The UI reports unavailable usage rather than inventing a
percentage. It preserves the existing billing and covered-access surfaces.

Changed contracts and evidence:

- Organization creation → persisted scope → authenticated workspace API:
  worker tests and the existing billing smoke cover personal/team creation.
- Approved quote → initial entitlement → workspace API: worker tests cover
  persistence, stable replay, invalid quotes, duplicate subscriptions, covered
  access, permission rejection, and project ownership isolation.
- Workspace API → real client → settings summary: RTL covers restrictions,
  mismatched workspace IDs, and stale responses. The browser smoke covers
  navigation, reload, and switching back to the personal workspace.
- Migration tests preserve legacy rows, support rerunning the migration, and
  enforce one explicit personal workspace per owner.
- Worker scope/migration/org-list tests: 19 pass. App summary/settings: 11 pass.
  E2E impact/determinism: 24 pass. Targeted billing smoke: two pass on the
  isolated local Postgres/worker/browser stack. No slow-request logs appear.
  Worker TypeScript and the production build pass. The build first caught an
  unsupported test-helper parameter property; explicit field initialization fixes
  it without changing test behavior. No test assertions were weakened.

Commands actually run:

```sh
# auth-worker directory
npx vitest run src/__tests__/billing-workspace.test.ts \
  src/__tests__/billing-workspace-migration.test.ts \
  src/__tests__/orgs-list.test.ts --maxWorkers=2
# worktree root
npx vitest run src/pages/settings/OrgSettingsBilling.test.tsx \
  src/components/org/BillingWorkspaceSummary.test.tsx --maxWorkers=2
npx vitest run scripts/e2e-impact.test.ts \
  scripts/e2e-determinism.test.ts --maxWorkers=2
npx tsc --noEmit -p auth-worker/tsconfig.json
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
npm run build
```

## Product implementation checkpoint — 2026-09-09

- [x] Preserve marketing source and public guide in local commit `c56b2cf4`
  on `codex/aqu-1091-pricing-preparation`. Its 79 targeted tests and build pass.
- [x] Preserve updated billing decisions and checklist in `e94de861b` before
  integrating current main into the AQU-837 worktree.
- [x] Replace the new-offer foundation's monthly allowances with weekly values
  and exact activation-anchored seven-day periods. Use entitlement version
  `2026-09-weekly`; existing subscription and metering ledgers remain unchanged.
- [x] Connect approved catalog configuration → Stripe account/Price reads →
  authenticated billing offers API → in-app plan comparison.
- [x] Display Individual and Team & Enterprise offers, relative capacity,
  monthly/annual selection, annual totals, and monthly equivalents.
  Internal units and Stripe Price IDs do not appear in the offer response.
- [x] Hide monetary offers on missing/invalid configuration or Stripe failures.
  Preserve existing plan, portal, and covered-access inquiry behavior.
- [x] Replace the old Field purchase control with gated new-plan comparisons.
  Comparing plans cannot create a checkout or change workspace access.
- [ ] Install environment-specific `STRIPE_PRICE_CATALOG` JSON plus the Stripe
  secret. The catalog must include account ID, ten approved bindings, and the
  weekly entitlement version. No default or hard-coded monetary fallback exists.
- [ ] Connect workspace eligibility, persistent entitlements, weekly metering,
  capability enforcement, and the new checkout/webhook path. This increment
  does not grant new plans or change actual usage enforcement.

The marketing checkpoint is local, not deployed. Its `/90-day-rollout` page
still has visible video and overview-download placeholders; complete those
before calling the whole site deployment-ready. Generated scratch output stays
in the marketing working copy. No scratch files were deleted.

Verification for this increment:

- Marketing: 79 tests across pricing, navigation, homepage positioning, rollout,
  and shared theme; `npm run build` passes.
- Auth worker: catalog, weekly pricing, and billing-route tests: 46 pass.
  `npx tsc --noEmit -p auth-worker/tsconfig.json` passes.
- App: billing settings, client, and provisioning tests: 11 pass.
- Catalog presentation → real billing client → comparison UI: four tests pass.
- E2E impact and determinism checks plus those four UI tests: 28 pass.
- App `npm run build` and `git diff --check` pass.
- Targeted `org-settings-billing.smoke.spec.ts`: passes on the real local
  Postgres/identity/sync/browser stack. The sandbox initially blocks Chromium;
  the permitted run passes without assertion changes. No worker slow-request
  logs appear in the passing run.

Changed contract: Stripe adapter and quote presentation produce `BillingOffers`;
its authenticated route, real client, and settings component consume it. Tests
cover their composition, account/mode/price validation, Team platform arithmetic,
missing prices, billing authority, and stale workspace responses. Weekly tests
cover exact boundaries and annual billing without extra resets. The existing
billing smoke and affected-E2E selector now cover the replacement surface.
The full payment journey and release smoke gate remain outstanding.
Specification: `aquilla-specs` commit `6e870ac` records the corrected boundary;
existing unrelated specification edits remain unstaged.

Commands run from the AQU-837 worktree unless noted:

```sh
# auth-worker directory
npx vitest run src/lib/billing/catalog.test.ts \
  src/lib/billing/pricing-model.test.ts \
  src/__tests__/billing-routes.test.ts --maxWorkers=2
# worktree root
npx vitest run src/pages/settings/OrgSettingsBilling.test.tsx \
  scripts/stripe-pricing-baseline.test.ts \
  src/lib/sync/billing.test.ts --maxWorkers=2
npx vitest run scripts/e2e-impact.test.ts \
  scripts/e2e-determinism.test.ts \
  src/components/org/BillingOffers.test.tsx --maxWorkers=2
npx tsc --noEmit -p auth-worker/tsconfig.json
npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts
npm run build
git diff --check
```

## Selected-plan review checkpoint — 2026-09-10

- [x] Add **Review plan** actions to the authenticated comparison surface.
  Show the selected offer, owning workspace, billing cadence, full charge,
  annual monthly equivalent, and weekly-reset explanation.
- [x] Recheck maintainer authority, workspace eligibility, and current Stripe
  catalog prices on the server. Reject unsupported quantities, legacy offers,
  and browser-provided amounts, prices, scope, or cohort overrides.
- [x] Explain ineligible workspaces and preserve existing or covered access.
  Reviews create no subscription, entitlement, event receipt, or cohort row.
- [x] Discard review state when the workspace, session, audience, or interval
  changes. Reject responses for a different workspace, offer, or interval.
  Focus the review region and keep checkout disabled.
- [ ] Carry selected offers through marketing and sign-in into this review.
- [ ] Connect a confirmed review to server-approved checkout and activation.
  Review does not reserve a price or authorize future purchasing; checkout
  must revalidate current eligibility and prices before creating a session.

The onboarding dispatch item appears under **Marketing → sign-in → workspace**.
It is a distinct follow-up, not a completed onboarding redesign.

Test impact: real organization creation produces scope and membership consumed
by the authenticated review route. The route consumes Stripe catalog validation
and workspace eligibility. The review presenter produces the response consumed
by the real billing client and UI. Worker tests cover all ten offer/cadence
combinations, restrictions, authority, tampering, current-price failure, and
absence of billing/cohort writes. RTL covers confirmed totals, covered access,
response mismatch, retry, stale responses, interval changes, and review focus.
The existing billing smoke still verifies unavailable prices and workspace
navigation; read-only review controls are covered in RTL, not a new smoke.
`e2e/JOURNEYS.md` records that boundary. Existing billing impact patterns select
all new billing paths.

Verification: worker review/workspace tests pass (28); app review/comparison/
settings tests pass (13); E2E impact/determinism pass (24); both existing billing
smoke journeys pass, with no slow-request logs. Worker TypeScript and the
production build pass. The final focus/layout refinement also passes its five
RTL tests, and the worker review suite passes all 13 after adding the no-cohort
assertion. Behavior-spec commit: `e5af737`. Commands:

```sh
# auth-worker directory
npx vitest run src/__tests__/billing-review.test.ts \
  src/__tests__/billing-workspace.test.ts --maxWorkers=2
# worktree root
npx vitest run src/components/org/BillingPlanReview.test.tsx \
  src/components/org/BillingOffers.test.tsx \
  src/pages/settings/OrgSettingsBilling.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2
npx tsc --noEmit -p auth-worker/tsconfig.json
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
npm run build
```

## Selected-offer continuity checkpoint — 2026-09-10

- [x] Add `/billing/select` as the app entry for a selected paid offer.
  Preserve supported marketing aliases through sign-in and account creation.
- [x] Preserve the selection after returning-account login and new-account
  setup completion, including creating or skipping a project. Ordinary Free
  onboarding retains its existing completion destinations.
- [x] Require an explicit workspace choice from the current account. Show only
  workspaces with billing authority; the review API still rechecks authority,
  scope, covered access, and prices. Never assign or purchase automatically.
- [x] Reject malformed/duplicate selection parameters, unsupported quantities,
  browser amounts, invalid audiences, and unknown offers or billing intervals.
  Late workspace responses from another account do not populate the chooser.
- [ ] Wire and verify public paid-plan links against the deployed app route.
  The marketing checkout currently has separate uncommitted edits; this app
  slice preserves them. Paid marketing CTAs remain gated in the inspected source.
- [ ] Complete the dedicated pricing-aware onboarding rework dispatch item.

Integration contract: the app accepts a paid-selection link such as
`/billing/select?offer=max-20x&interval=annual&quantity=1&audience=individual`.
Supported marketing offer names are `pro`, `max-5x`, `max-20x`, `team`, and
`team-20x`; monthly/annual normalize to month/year. Internal underscore names
and month/year also work. Quantity must be one. Optional audience must match.
Only these selection parameters are accepted. Pass this complete URL as the
safe `next` parameter to `/login`; its Create account link preserves the same
selection in `/onboarding`. URLs carry preferences, never authorization or
prices. Reloading retains the selection because it stays in the URL; no shared
localStorage purchase intent can leak between accounts.

Changed contracts: marketing-style selection → canonical app path → safe login
return or signup continuation → explicit workspace choice → existing server
review. Parser/composition, Login, wizard returning/new-account completion, and
chooser RTL tests cover this chain. The existing billing smoke uses the real
selection-path producer, workspace directory, authenticated review, and UI to
reject an Individual offer for a team workspace. The billing E2E sentinel now
also covers Login and onboarding-wizard changes.

Targeted verification: 79 unit/RTL/impact/determinism tests pass. Both billing
smoke tests pass. No worker implementation changes occur in this slice.
All eight affected login/session/account-switching smoke tests pass. The final
production build passes. No slow-request logs appear in the auth smoke run.
Behavior-spec checkpoint: `6942245`.

```sh
npx vitest run src/lib/billing/intent.test.ts \
  src/pages/BillingSelection.test.tsx src/pages/Login.test.tsx \
  src/components/onboarding/__tests__/OnboardingWizard.skip.test.tsx \
  src/components/onboarding/__tests__/OnboardingWizard.fork.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts \
  src/components/AuthRedirectFlow.test.tsx --maxWorkers=2
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/auth/login-account-setup-status.smoke.spec.ts \
  e2e/specs/auth/session-expired-banner.smoke.spec.ts \
  e2e/specs/orgs/account-switcher.smoke.spec.ts --shard=1/1
npm run build
```

## Durable sandbox checkout checkpoint — 2026-09-10

This increment implements a local sandbox rehearsal path, not production
checkout or paid activation. The public UI remains disabled. No actual Stripe
session, charge, secret installation, or deployment occurs during verification;
Stripe responses are mocked while database and HTTP handlers are real.

- [x] Pass the real review response into server-side checkout validation for all
  five offers and both billing intervals. Confirm price version, currency, and
  full total against a freshly validated catalog; browser values never price
  a session. Team 20× contains one platform line and one capacity line.
- [x] Persist one immutable request per workspace before contacting Stripe.
  Keep approved catalog/price/quote snapshots, request parameters, account,
  and a durable idempotency key. Network calls run outside the database lock.
- [x] Reuse that key and exact parameters after an ambiguous Stripe response or
  a failure saving the returned session. Concurrent attempts share the same
  request. Persisted sessions are retrieved before reuse; closed sessions block.
- [x] Recheck workspace eligibility under the lock and block conflicting
  existing pricing assignments. Refuse changed offers or stale/expired attempts
  until their external outcome is reconciled. Never rotate a key on uncertainty.
- [x] Validate the returned session identity, workspace reference, test mode,
  subscription mode, attempt metadata, and Stripe-hosted HTTPS redirect.
- [x] Prevent rehearsal events from entering the legacy Field webhook path.
  Initial signed payment activation is now implemented in the 2026-09-11
  checkpoint below. Unsupported lifecycle events still return a retryable error.
- [x] Fix the JSON representation boundary in both checkout requests and initial
  entitlement price IDs. Real postgres.js previously double-encoded serialized
  JSON; bind as text before casting to JSONB. Assert object/array shapes through
  the production adapter and enforce checkout shapes in the database.
- [x] Connect signed sandbox payment reconciliation to the stored attempt and
  atomic initial entitlement activation in local integration tests.
- [ ] Verify the real Stripe payment-to-access journey, including feature gates
  and usage enforcement; local mocked-Stripe activation does not satisfy this gate.
- [x] Reconcile confirmed expiry and explicitly abandoned checkout sessions
  before permitting replacement. Preserve history; unknown session identities
  remain blocked. See the recovery checkpoint below.
- [ ] Connect the UI and production checkout only after the remaining payment,
  lifecycle, metering, and release gates pass.

Migration `0093_workspace_checkout_attempts.sql` is prepared, not deployed.
The endpoint is `POST /orgs/:orgId/billing/checkout-rehearsal`, with billing
maintainer authorization. It requires all of: loopback request hostname,
`WRANGLER_LOCAL=1`, `BILLING_WORKSPACE_CHECKOUT_REHEARSAL=true`, a test Stripe key,
and a loopback `BASE_URL` for app return links. No deployment config enables it.
Never set the local bypass on a deployed worker. The request accepts the offer,
interval, quantity one, and `confirmedPriceVersion`, `confirmedTotalAmount`,
`confirmedCurrency` from the review. Unknown fields are rejected.

Sessions expire after 23 hours; retries stop 30 minutes before that boundary.
These are technical rehearsal limits, not subscription policies. Stripe may
prune idempotency keys after 24 hours; unresolved attempts remain blocked instead
of silently creating another session. See [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
and [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create).
The stored request holds no Stripe secret. Its confirmed result grants no access.

Test impact: authenticated review produces the values consumed by checkout;
validated catalog composition produces line items consumed by the Stripe REST
adapter. The durable database record produces parameters for both initial send
and retry. Signed rehearsal metadata is consumed by the webhook guard. Tests
cover all these boundaries with real handlers and schema. A real-Postgres run
caught the JSON bug despite passing PGlite tests; that regression remains in the
production-adapter suite, including the initial-entitlement writer.

Verification so far: 92 worker tests pass, 35 tests pass against disposable real
Postgres databases, 33 app/impact/determinism tests pass, and worker TypeScript
passes. The production build and both billing smoke journeys pass, with no
slow-request logs. The signed rehearsal guard covers checkout, subscription
updates/deletion, and both invoice metadata formats. Spec commit: `4a91e97`.

```sh
# auth-worker directory
npx vitest run src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace.test.ts src/__tests__/billing-review.test.ts \
  src/lib/billing/catalog.test.ts \
  src/__tests__/billing-workspace-migration.test.ts \
  src/__tests__/billing-routes.test.ts \
  src/__tests__/billing-webhook-recovery.test.ts --maxWorkers=2
npx vitest run --config vitest.webhook-postgres.config.ts
# worktree root
npx vitest run scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts \
  src/components/org/BillingOffers.test.tsx \
  src/components/org/BillingPlanReview.test.tsx --maxWorkers=2
npx tsc --noEmit -p auth-worker/tsconfig.json
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
npm run build
```

## Initial sandbox payment checkpoint — 2026-09-11

Signed payment reconciliation now connects the saved checkout request to a
workspace plan in the local rehearsal. Actual paid feature enforcement and the
complete customer journey remain unfinished. No real Stripe request, charge,
secret installation, live catalog copy, or deployment occurs in these tests.

- [x] Retrieve the completed, paid test session and active subscription from
  Stripe before acquiring the workspace lock. Match the account, customer,
  subscription, workspace, immutable request metadata, approved price IDs,
  quantities, currency, and totals. Team 20× requires both expected lines.
- [x] Use the saved catalog and quote rather than a newer price configuration.
  Require a valid webhook signature even when the local auth bypass is enabled.
- [x] Atomically commit the receipt, recovered session ID, and initial entitlement.
  Failures in any write roll back all three. Concurrent retries grant one plan;
  exact replay preserves its first seven-day usage anchor.
- [x] Handle paid `checkout.session.completed` and
  `checkout.session.async_payment_succeeded`. An earlier unpaid completion cannot
  establish the activation anchor, even if a later Stripe read reports payment.
- [x] Expose the saved plan and weekly period through the authorized workspace
  API. A different workspace retains its own entitlement and allowance context.
- [x] Keep subscription lifecycle events out of legacy Field handling, including
  events without metadata when the subscription identity is already stored.
- [ ] Configure and verify async-success delivery on the sandbox webhook before
  testing delayed payment methods. The existing disabled endpoint has four
  events and has not been changed by this checkpoint.
- [ ] Implement renewal, failed-payment, cancellation, and plan-change
  reconciliation after the launch policies are approved. These events currently
  remain retryable; no lifecycle state or feature enforcement is implied.
- [x] Show the persisted new plan and billing cadence in the main billing card.
  Use anchored weekly usage wording for new plans and retain legacy billing
  behavior for existing subscriptions. See the display checkpoint below.

The rehearsal remains restricted to loopback requests, explicit local opt-in,
`WRANGLER_LOCAL=1`, test credentials, and a configured signing secret. Live mode
is rejected. Discounts, tax-adjusted totals, trials, and manual invoicing are
not supported by this initial exact-quote rehearsal. Do not enable customer
checkout until the complete pricing and lifecycle policy is implemented.

Test impact: the real review/checkout producer supplies persisted parameters to
Stripe-shaped fixtures, then the signed webhook consumes them through the real
Postgres adapter. The workspace API consumes the resulting entitlement. Tests
cover all ten offer/cadence combinations, invalid payment mappings, delayed
payment, duplicate delivery, cross-workspace isolation, and transaction rollback.
The existing billing UI's paid-period branch has RTL coverage; the billing smoke
remains the browser sentinel. Stripe transport is mocked throughout.

Validation commands (2026-09-11):

```sh
# auth-worker: targeted worker tests, 115 passing
npx vitest run src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace.test.ts \
  src/__tests__/billing-webhook-recovery.test.ts \
  src/__tests__/billing-routes.test.ts \
  src/lib/billing/catalog.test.ts --maxWorkers=2

# auth-worker: disposable local Postgres, 73 passing
npx vitest run --config vitest.webhook-postgres.config.ts

# repository root: paid-period RTL and test selection, 32 passing
npx vitest run src/components/org/BillingWorkspaceSummary.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts \
  --maxWorkers=2
npx tsc --noEmit -p auth-worker/tsconfig.json
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```

Worker TypeScript and the production build pass. Both billing smoke journeys
pass with no slow-request logs. The first smoke attempt could not launch
Chromium inside the filesystem sandbox; the permitted local-browser run passes.
No application assertion was weakened or retried to mask a failure.

See [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment) for payment
status checks, duplicate fulfillment, and delayed-payment event handling.

## Workspace plan display checkpoint — 2026-09-11

- [x] Use one authorized workspace response for the main plan and workspace
  summary. Show Pro, Max 5×, Max 20×, Team, or Team 20× and monthly/annual cadence.
  New-plan pages do not request the legacy billing endpoint or infer Free.
- [x] Describe new usage as anchored seven-day periods with no rollover. Preserve
  legacy rolling-window copy and existing customer portal actions for old plans.
- [x] Discard responses after workspace/session changes. Show billing unavailable
  with retry on failure, rather than a false plan or permissions message.
- [x] Add refresh after checkout return without treating a redirect as payment.
- [x] Remove the old Explore/Field subtitle and customer-facing credit wording.
- [x] Exercise entitlement writer → Postgres → workspace API → browser across
  reload and workspace changes. Keep existing Free and Field checks.
- [ ] Connect new-plan portal actions after lifecycle policy and configuration
  are ready; payment renewal dates and measured usage remain pending.

Verification: 19 billing UI tests plus 24 impact/determinism checks pass; 85
worker tests cover the producer's billing interval and catalog composition.
The expanded billing smoke has three passing journeys. It records a Team 20×
plan through the actual entitlement writer in the isolated E2E database and
checks paid-plan persistence, legacy isolation, reload, and navigation. The
browser screenshot confirms the plan/cadence and weekly period. No slow-request
logs appear. The JSON fixture loader supports both Node and the worker compiler;
shared catalog validation remains independent of Worker environment types.

Commands:

```sh
npx vitest run src/pages/settings/OrgSettingsBilling.test.tsx \
  src/components/org/BillingWorkspaceSummary.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2
# auth-worker
npx vitest run src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace.test.ts src/lib/billing/catalog.test.ts \
  --maxWorkers=2
# repository root
npx tsc --noEmit -p auth-worker/tsconfig.json
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```

## Checkout recovery checkpoint — 2026-09-11

- [x] Preserve every checkout request. Permit only one unresolved request per
  workspace with a partial unique index; migration `0094` preserves old rows.
- [x] Reconcile the saved session with the same Stripe account. Release it only
  when Stripe confirms `expired`, `unpaid`, and no subscription. Elapsed time,
  browser cancellation, or a missing session ID never proves a safe replacement.
- [x] Add an explicit abandon-checkout operation. Only an open checkout is
  expired, using its own idempotency key. A completed session never reaches the
  expiry endpoint, and no operation cancels an existing subscription.
- [x] Recover a lost expiry response by retrieving the session before retrying.
  Database failures leave the attempt unresolved. Concurrent confirmations
  preserve history and one pending request. A replacement gets a fresh key.
- [x] Reject late payment application to a resolved attempt atomically, without
  leaving an acknowledged event receipt or granting a plan.
- [ ] Verify actual sandbox expiry and replacement with configured credentials.
  The tests below mock Stripe transport; they create no external sessions.

Local-only, maintainer-authorized POST endpoints:

- `/orgs/:orgId/billing/checkout-rehearsal/reconcile`: read and reconcile state.
- `/orgs/:orgId/billing/checkout-rehearsal/expire`: explicitly abandon an open
  checkout, then reconcile the confirmed result.

Both retain the existing loopback, test-key, and explicit rehearsal gates.
They return `none`, `open`, `payment_pending`, or `expired`; these statuses do
not grant entitlements. A session with unknown identity requires reconciliation
before replacement. Migration `0094_workspace_checkout_recovery.sql` is prepared,
not deployed. Apply migrations before deploying code that reads the new columns.

Validation: 105 targeted worker tests, 88 real-Postgres tests, worker TypeScript,
production build, and all three billing browser journeys pass. The migration
replay test preserves history and enforces the partial uniqueness constraint.
No slow-request logs appear in the final smoke run. Contract coverage composes
real checkout requests with expiry responses, persistence, replacement creation,
and signed payment rejection; assertions cover both adapters and real HTTP routes.

```sh
pnpm --dir auth-worker exec vitest run \
  src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace-migration.test.ts \
  src/__tests__/billing-workspace.test.ts \
  src/__tests__/billing-webhook-recovery.test.ts --maxWorkers=2
pnpm --dir auth-worker exec vitest run \
  --config vitest.webhook-postgres.config.ts
pnpm --dir auth-worker exec tsc --noEmit
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```

See [Stripe session states](https://docs.stripe.com/api/checkout/sessions/object)
and [explicit session expiry](https://docs.stripe.com/api/checkout/sessions/expire).

**Next dependency:** Ryder's answers on payment-failure grace, cancellation timing,
and upgrade/downgrade timing were requested on 2026-09-11 and remain pending.
No default was accepted on Ryder's behalf. These rules govern subscription
lifecycle reconciliation and when paid AI access changes.

## Production launch checklist

**Status: not ready to enable paid checkout.** Prices are ready in sandbox;
the new plans still need end-to-end integration. This checklist supersedes the
older Field launch instructions below. Ryder requests production launch on
2026-09-09; complete and verify these steps before enabling purchases.

- [x] Approve launch prices and create the sandbox catalog.
- [x] Test price mapping, capacity calculations, and experiment assignment.
- [ ] Set launch rules: maximum blocks, payment failures, upgrades/proration,
  cancellation/downgrades, and Team collaborator/reviewer access.
- [ ] Connect the new catalog to checkout, signed webhooks, workspace plans,
  weekly allowance resets, percentage usage, enforcement, and covered access.
- [ ] Update app and marketing prices, plan names, allowances, and purchase links.
- [ ] Install sandbox secrets, enable the dev webhook, and test a complete
  payment → correct workspace access → renewal/cancellation journey. Verify
  duplicate events, failed payments, and the customer portal.
- [x] Owner reports completing business verification in Chrome on 2026-09-11.
  This records Ryder’s confirmation; charge/payout readiness still needs verification.
- [ ] Confirm Stripe charge/payout readiness; create and verify live prices,
  the production webhook, live secrets, and customer portal configuration.
- [ ] Connect plan/cohort properties to billing and product activity for retention.
  Apply the cohort migration if used; keep price experiments off at launch.
- [ ] Commit/review the release, pass build and full smoke checks, and deploy
  app/API/marketing with paid checkout disabled. Preserve existing subscriptions.
- [ ] Verify production configuration, enable paid checkout, and confirm the first
  authorized purchase grants the right access. Monitor webhook/payment failures;
  disable new checkout if the payment-to-access path fails.

**Live catalog preparation — 2026-09-11:** defer copying everything from sandbox.
Finish the payment-to-access rehearsal, then promote only the approved catalog
and verify its live price mappings. Configure and verify live secrets, webhook,
and customer portal separately. Reuse the approved pricing model; no wholesale
reimplementation is needed. Sandbox testing does not depend on a live copy.

**Still open:** the maximum self-service block quantity. Keep quantities above
one unavailable until approved. Sandbox setup alone does not make billing ready.

## Complete customer journey: remaining app and marketing work

Customer-facing rule: show percentage usage and relative capacity, never credits.
This applies to app screens, marketing, notifications, and limit errors. Internal
credit values below document implementation only, not copy to publish.

These are implementation tasks, not just Stripe dashboard settings. The prepared
Field page and checkout remain an older draft until these steps are complete.

1. **Marketing → selected offer.** Replace Field with Team and add the Individual
   and Team & Enterprise tabs, defaulting to Team & Enterprise. Support deep links,
   monthly/annual selection, and approved block quantities. Show monthly equivalents
   and annual totals from a validated Stripe catalog. Show relative capacity with explicit baselines, hide internal credit counts,
   and explain weekly allowance resets,
   exhaustion, cancellation, and additional capacity. Keep Enterprise and ETEN /
   Bible-translation inquiry paths; never imply affiliation automatically grants access.
2. **Selected offer → correct workspace.** Carry offer and interval through sign-in,
   then confirm the personal or team workspace being upgraded. Check billing authority
   on the server. Organization-owned projects consume that organization's allowance;
   a member's personal subscription must not pay for them. Billing settings show the
   current plan, percentage used, allowance reset date, renewal date, upgrade
   options, and eligible portal access. Never display internal credit counts.
3. **Workspace → Stripe Checkout.** Resolve approved Price IDs on the server, validate
   quantity and workspace eligibility, and retain the assigned pricing cohort. Team
   20× sends one platform item plus N capacity items. Never accept client-supplied
   amounts or grant access merely because the browser reaches the success page.
4. **Signed payment events → access.** Verify webhook signatures and apply events
   idempotently to the correct workspace. Persist subscription, price/entitlement
   versions, capacity, and the original weekly usage anchor. Reconcile renewal,
   failure, cancellation, upgrades, and downgrades under the approved launch rules.
   Preserve legacy subscriptions and negotiated or sponsored access.
5. **Access → usable allowance.** Keep credit accounting internal. Allocate and consume weekly capacity safely across
   concurrent requests. Annual billing still resets usage every seven days. Enforce personal
   versus shared pools, no rollover, and capacity changes without erasing consumed
   usage. Confirm member limits and reviewer permissions match advertised plans.
6. **Ongoing use → management and measurement.** Test portal invoices, payment-method
   changes, cancellation, and covered-access administration. Emit consent-respecting
   workspace plan/cohort properties with activation, useful-work, and paid-renewal
   events. Deduplicate invoice events and separate annual product retention from
   payment retention. Build retention views; keep experiments disabled initially.
7. **Verify → launch.** Exercise marketing selection → sign-in → workspace selection
   → sandbox checkout → webhook → displayed plan → actual allowed work. Cover both
   billing intervals, all offer shapes, failed/duplicate events, renewal, cancellation,
   allowance exhaustion/reset, and covered access. Run affected tests plus the full
   smoke/build release gates. Deploy with checkout off, verify live catalog/secrets/
   webhook mappings, then enable purchases and monitor the payment-to-access path.

Before integrating, reconcile migration numbers against current main: another
working-copy change uses `0090_org_entitlements.sql`, while this branch adds
`0090_billing_price_cohorts.sql`. Assign unique migration numbers and verify their
combined schema before applying either as part of the release.

## Working checklist and evidence — 2026-09-09

Use this section to track individual deliverables under the production checklist.
A checked item means its stated scope has evidence. It does not imply deployment.
Keep each production item open until all its acceptance checks pass.
Record environment, commit, command or Stripe object ID, outcome, and date.
Never put credentials, signing secrets, or customer payment details in this document.

### Starting position

- [x] Confirm AQU-837 is Dispatched and assigned to Ryder in Linear.
- [x] Confirm the requested worktree contains the approved pricing document,
  sandbox manifest, quote module, and persisted cohort module.
- [x] Inspect the checkout and webhook routes against the target journey.
  Checkout still selects Field prices; new offer resolution is not connected.
- [x] Identify the existing billing smoke journey in `e2e/JOURNEYS.md`.
  Extend `org-settings-billing.smoke.spec.ts` for the new cross-layer contract.
- [x] Fetch and merge current `origin/main` into the isolated AQU-837 worktree.
  The merge completes without conflicts; earlier billing commits remain preserved.
- [ ] Resolve the migration-number collision and verify the combined schema.

Source inspection: `auth-worker/src/routes/billing.ts`,
`auth-worker/src/lib/billing/apply.ts`, `docs/pricing/pricing-model.md`,
and `e2e/JOURNEYS.md`. No sandbox or live payment verification occurs in this update.

### Launch decisions — commercial owner: Ryder

Approval must include the rule and date. Unchecked decisions remain unresolved;
this checklist does not approve proposed commercial behavior.

- [ ] Maximum self-service 20× block quantity: **pending**.
  Keep quantity above one unavailable until approval and enforcement are complete.
- [ ] Failed-payment rule: **pending**. Specify grace duration, access during
  retries, recovery behavior, and the final unpaid state.
- [ ] Upgrade rule: **pending**. Specify effective time, Stripe proration,
  additional allowance, and payment requirements before granting capacity.
- [ ] Downgrade rule: **pending**. Specify effective time, allowance treatment,
  and handling when current usage or membership exceeds the lower plan.
- [ ] Cancellation rule: **pending**. Specify period-end versus immediate
  cancellation, refunds, remaining allowance, and the resulting workspace plan.
- [ ] Individual reviewer permissions: **pending**. Define allowed actions and
  confirm the proposed three active guest reviewers across the workspace.
- [ ] Team collaborator limit: **pending**. Confirm whether 20 includes the owner
  and define which roles count toward the limit.
- [ ] Team and Enterprise support commitments: **pending**. Approve customer copy
  against the services actually provided.
- [ ] Existing-customer treatment: document preservation of existing prices,
  billing periods, negotiated access, and allowance rules. Any migration needs
  separate approval; renaming Field does not authorize migration.

### Marketing → sign-in → workspace

- [x] Prepare the [pricing-aware onboarding handoff](pricing-onboarding-handoff.md)
  with acceptance criteria, test boundaries, and coordination with AQU-837.
  It is prepared, not dispatched; role and support decisions remain explicit.
- [ ] Dispatch a dedicated, more comprehensive onboarding rework for the pricing
  tiers. Cover selected-offer continuity, personal versus team workspace setup,
  roles/invites, covered-access discovery, plan capabilities, and first useful
  work. Define its acceptance criteria and coordinate ownership with this
  billing integration before dispatch; do not assume a plan selection grants
  access. Requested by Ryder on 2026-09-10. Track the assigned task and handoff
  here when dispatched.
- [ ] AQU-1091: implement Individual and Team & Enterprise tabs, defaulting to
  Team & Enterprise. Preserve audience, offer, interval, and quantity in links.
- [ ] Replace superseded Field copy across cards, comparisons, FAQs, and app UI.
  Show shared Team allowances and weekly resets for annual subscriptions.
- [ ] Render public amounts from a validated Stripe-derived catalog snapshot.
  Test unavailable, inactive, wrong-mode, and mismatched prices.
- [ ] Show annual totals and monthly equivalents; keep Enterprise rollout and
  covered-access inquiries available.
- [ ] Carry the selected offer through sign-in and confirm the target workspace
  before checkout. Reject invalid or obsolete selections on the server.
- [x] Verify personal versus team workspace eligibility and server-side billing
  authority. Test another workspace's ID and a member without billing authority.
  `9b1240273` verifies this for explicit new scopes; existing scope needs review.
- [ ] Show the current plan, capacity, usage, reset date, renewal date, and
  eligible portal actions in billing settings.

### Workspace → approved Stripe Checkout

- [x] Prepare the approved ten-price sandbox manifest and offer composition.
  Evidence: `config/pricing/stripe-sandbox.json` and prior contract checks below.
- [x] Retrieve and validate Stripe Prices through the billing API. Hide amounts
  and purchase actions when Stripe pricing cannot be verified.
  Catalog-to-app checkpoint `194c894d4`; environment secrets remain uninstalled.
- [ ] Resolve the selected offer from server-approved Price IDs and the persisted
  workspace cohort. Reject browser-supplied prices, amounts, and cohort overrides.
- [ ] Connect all five paid offer shapes for monthly and annual checkout:
  Pro, Max 5×, Max 20×, Team base, and Team 20×.
- [ ] Assert Team 20× charges the platform once and capacity at quantity N.
  Assert its allowance is 1,000 × N, without the base 250 units.
- [ ] Enforce the approved quantity limit and exclude existing, sponsored, or
  negotiated subscriptions from inappropriate self-service purchase paths.
- [ ] Prevent repeated checkout attempts from creating duplicate subscriptions.
- [ ] Keep browser success redirects informational until verified payment state
  reaches the owning workspace.

### Signed events → durable workspace access

- [ ] Install the sandbox API and signing secrets through the secret manager.
  Verify account and environment without exposing secret values.
- [ ] Enable the recorded dev webhook after compatible code and configuration
  are deployed. Confirm its subscribed events support the approved failure rule.
- [ ] Test valid, invalid, and missing signatures using the configured event
  payload shape. Local unsigned bypass does not verify Stripe signatures.
- [ ] Persist subscription identity, approved prices, entitlement and price
  versions, scope, capacity, and the original weekly usage anchor.
- [x] Make event application and deduplication recoverable together. Test a
  failure after receipt recording, then redelivery of the same Stripe event.
- [ ] Test duplicate and out-of-order events, simultaneous delivery, and an
  invoice arriving before subscription-to-workspace mapping exists.
- [ ] Reconcile paid renewal, failed payment, recovery, cancellation, upgrade,
  and downgrade according to the approved rules.
- [ ] Preserve legacy and covered access through subscription updates and replay.
  Reject events whose subscription/customer mapping conflicts with the workspace.

Recovery is verified locally in integrated commit `4275e43e5`: receipt and
projection effects commit atomically under a workspace lock. Failure after
receipt insertion or at commit rolls back both; redelivery applies successfully.
Database lookup/schema failures return errors, never successful acknowledgements.
Combined workspace and legacy billing worker coverage passes 63 tests. The
separate live-Postgres gate passes 14 tests, including observable lock contention.
Worker TypeScript and the integrated production build pass. The targeted
billing smoke passes both journeys again after integration, with no slow-request
logs. The agent's handoff records its original reproduction,
commit identities, commands, and remaining limits. Spec commit: `cdf1ef9`.

Integrated commands:

```sh
# auth-worker directory
npx vitest run src/__tests__/billing-webhook-recovery.test.ts \
  src/__tests__/billing-workspace.test.ts \
  src/__tests__/billing-routes.test.ts \
  src/__tests__/admin-billing.test.ts \
  src/__tests__/billing-plans.test.ts --maxWorkers=2
npx vitest run --config vitest.webhook-postgres.config.ts
```

Synthetic signed HTTP payloads exercise signature checks and retry recovery;
no actual Stripe destination delivery has run. Out-of-order events, missing
subscription mappings, historical receipt repair, and same-workspace covered
access reconciliation remain open. Initial new-entitlement persistence is not
yet called by the webhook; future effects must share its transaction. These
checks do not complete the full payment or launch gates.

### Workspace access → actual allowed work

- [ ] Select the allowance using project ownership. A member's personal plan
  must never fund work on an organization's project.
- [ ] Allocate weekly allowances idempotently, including continuous seven-day
  periods across annual subscriptions, anchored to activation or workspace creation.
- [ ] Verify exact seven-day boundaries, no rollover, and recovery after inactivity.
  Preserve the activation anchor across calendar changes and invoice renewals.
- [ ] Enforce credits across concurrent AI requests and retries. Verify the
  actual work endpoint and persisted ledger, not only the billing display.
- [ ] Preserve consumed usage during capacity changes and payment-event replay.
- [ ] Exhaust the allowance and confirm AI work stops while existing work,
  manual editing, and export remain available.
- [ ] Enforce reviewer actions and collaborator limits on server operations.
- [ ] Verify covered-access provisioning, approved caps, and the absence of
  payment prompts for organizations without a Stripe subscription.

### Management and retention

- [ ] Verify portal invoices, payment-method changes, and cancellation end to
  end. Keep unverified portal plan/quantity switching disabled.
- [ ] Connect stable workspace plan/cohort properties to consent-respecting
  exposure, activation, useful-work, and paid-renewal events.
- [ ] Deduplicate paid renewal invoices and exclude prorations, expansion,
  zero-value invoices, and checkout redirects from renewal counts.
- [ ] Build monthly and annual retention views with separate product-activity
  and payment measures. Keep price experiments disabled for launch.

### Sandbox acceptance matrix

Each row needs evidence from Stripe → webhook → stored entitlement → displayed
plan → actual allowed work. All rows are **not run for the new model**.
Foundation unit tests do not complete these rows.

| Offer | Monthly journey | Annual journey | Internal weekly allowance |
| --- | --- | --- | ---: |
| Pro | Not run | Not run | 50 |
| Max 5× | Not run | Not run | 250 |
| Max 20×, one block | Not run | Not run | 1,000 |
| Team base | Not run | Not run | 250 shared |
| Team 20×, one block | Not run | Not run | 1,000 shared |

After quantity approval, add both intervals at the maximum supported quantity
and prove the next quantity is rejected. Test cancellation, payment failure and
recovery, duplicate/reordered delivery, weekly reset, exhaustion, workspace
isolation, and covered access alongside this matrix.

### Release and production acceptance

- [ ] Record targeted unit, producer→consumer integration, and billing smoke
  results against the integrated release commit.
- [ ] Reconcile the behavior spec and update the journey registry and affected
  E2E selection when coverage changes.
- [ ] Pass `npm run build` and the complete `npm run test:e2e:smoke` release gate.
  Investigate any worker slow-request logs before release.
- [ ] Complete owner-confirmed business/payout activation and verify live prices,
  account identity, webhook, secrets, tax treatment, and portal configuration.
- [ ] Deploy reviewed app/API/marketing commits with paid checkout disabled.
  Record commits, deployment identifiers, migrations, and environment checks.
- [ ] Confirm the rollback operator and checkout-disable procedure. Preserve
  webhook processing and existing subscriptions when disabling new purchases.
- [ ] Enable checkout only after every applicable production gate passes.
- [ ] Confirm the first authorized production purchase grants correct workspace
  access. Record redacted evidence and monitor webhook/payment failures.

### Earlier checklist-only update: test impact

This update changes documentation only. It adds acceptance criteria and records
source inspection; no runtime producer, consumer, or product behavior changes.
No regression tests change or run for this documentation update. Earlier test
results below remain historical evidence, not a new verification run.
Validation: `git diff --check` and review against the pricing model and current
checkout/webhook source. AQU-837 remains Dispatched; release gates remain open.

## Earlier baseline catalog and experiment readiness — 2026-09-09

Historical preparation record: the monthly allowances below are superseded by
the weekly contract and product checkpoint above. Prices remain unchanged.

The supplied baseline prices are approved and now exist in the Stripe sandbox.
`config/pricing/stripe-sandbox.json` records all ten verified price IDs; amounts
must still be retrieved from Stripe at runtime, never treated as fallback values.
`config/pricing/baseline.json` is the provisioning specification, not display data.

- Pro: $20 monthly / $200 annually.
- Max 5×: $60 monthly / $600 annually.
- Max 20×: $120 monthly / $1,200 annually per 4,000-credit block.
- Team: $600 monthly / $6,000 annually, using the existing two sandbox prices.
- Team 20×: Team platform quantity one plus the separate Team capacity price
  at quantity N ($120 monthly / $1,200 annually per block). Its credit total
  is 4,000 × N, with no base 1,000 credits added.
- Aquilla Field was renamed Aquilla Team in this sandbox. Pro and Max are new
  sandbox products. New prices have baseline-version and component metadata.
- Team capacity has separate Price IDs from personal Max capacity, allowing
  individual experiments without changing Team economics.
- No subscription, charge, live price, or price experiment was created.
- Self-service quantities above one remain unavailable pending the approved
  maximum. The quote engine supports recurring blocks and tests larger quantities.

### Experiment and retention configuration

Keep entitlement version (`2026-09`) separate from price version
(`2026-09-baseline`). New experiments get new Stripe Prices and a new immutable
catalog version. Never mutate or transfer old price mappings. The higher
$30/$80/$160 ladder in the supplied rationale is a future hypothesis only.

`price-cohorts.ts` persists workspace-level assignments and first exposure;
concurrent requests cannot create different offers. Changing weights or disabling
an experiment preserves existing assignments. Existing/sponsored subscribers
must be excluded by the server eligibility check. Do not trust browser-provided
eligibility, cohort, price ID, or total. Do not assign on every page view.

`pricingEventProperties()` emits stable plan, capacity, scope, quantity, interval,
price version, entitlement version, price IDs, experiment/variant, and immutable
acquisition-price version. Attach these to event-time records, not only mutable
person profiles. Use workspace groups so a personal subscription and membership
in a Team workspace do not overwrite each other. Preserve analytics consent.

Production wiring is still required: catalog API, assignment eligibility,
render-confirmed exposure endpoint, signed webhook financial history, product
activity events, and PostHog cohorts/dashboards. No new analytics transmission
or experiment rollout has been enabled. Migration 0090 is prepared, not applied.
For payment retention count unique paid renewal invoices, not checkout success,
$0 invoices, prorations, expansion invoices, or duplicate deliveries. Compare
annual subscriptions using monthly product activity, not monthly payment counts.

### Re-running sandbox provisioning

Use `scripts/stripe-pricing-baseline.ts` with a sandbox key supplied through the
normal secret environment. Set these non-secret overrides to reuse this account:

- `STRIPE_TEAM_PRODUCT_ID=prod_VE0arPBinZTim4`
- `STRIPE_TEAM_MONTHLY_PRICE_ID=price_1UDYZN5Mw0X7gcTSRgNbXJlH`
- `STRIPE_TEAM_ANNUAL_PRICE_ID=price_1UDYa35Mw0X7gcTSUQa6rIup`

The script never enables checkout or creates subscriptions. It refuses live keys,
reuses matching catalog entries, and rejects mismatched prices instead of changing
them. Its output is the Price-ID/entitlement manifest. The old Field script's
command-line entry is retired. No Stripe secret is installed locally yet; this
session used Stripe's authenticated sandbox Workbench for catalog preparation.

## Current source of truth

`docs/pricing/pricing-model.md` (2026-09-09) supersedes the earlier Field offer
below. Team replaces the customer-facing Field name for new offers. New offers
use activation-anchored seven-day usage periods, including annual subscriptions. Existing Field
subscriptions and negotiated access must retain their rules until migration
is explicitly approved. The older sections below document the prepared v5
implementation, not the new target or a ready-to-launch system.

### Webhook approval and creation

On 2026-09-09 Ryder explicitly approved the development webhook and the eventual
production webhook. Created the sandbox destination:

- ID: `we_1UDmyn5Mw0X7gcTSkASnTNcl`
- URL: `https://api.dev.aquilla.app/identity/api/v2/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`
- Snapshot API version: `2026-07-29.dahlia`
- Verified state: **Disabled** pending signing-secret installation and tests.
- Secret remains unretrieved/uninstalled. No events have been tested.
- Production webhook approval is recorded for the corresponding endpoint at
  `https://api.aquilla.app/identity/api/v2/billing/webhook`; it is not created yet.
- AQU-837 and AQU-1091 are Dispatched and assigned to Ryder with his approval.

### New model implementation status

The new contract module `auth-worker/src/lib/billing/pricing-model.ts` implements
allowance packaging, month-end-safe anniversary calculation, and explicit
approved-price resolution. Prices come from Stripe objects; they are not
hard-coded in this module. It rejects unknown/duplicate price bindings, inactive
or wrong-mode prices, legacy four-week intervals, and unsupported quantities.
Only 20× blocks can increase quantity. Team 20× uses the approved platform
plus capacity line-item structure; customer checkout wiring remains incomplete.

This is a tested foundation, **not connected to deployed billing, usage,
permissions, checkout, or marketing yet**. The prepared v5 app and marketing
still describe the earlier offer. Do not launch them as the new model.
Prices are approved. The maximum self-service block quantity remains open.

### Remaining implementation boundaries

1. Stripe catalog adapter → authenticated billing API → current subscription
   amounts and validated marketing snapshot. Hide amounts/actions on failure.
2. Paid subscription events → versioned workspace entitlements, preserving
   existing Field subscriptions and negotiated access. Store the original
   monthly anniversary anchor separately from invoice renewal periods.
3. Metering → shared workspace allowance, with concurrency-safe consumption
   and idempotent monthly allocation. Capacity changes retain consumed usage.
   Resolve payment failure, upgrade allocation and proration policies first.
4. Personal/team project ownership → allowance selection and permissions.
   Confirm reviewer actions and whether the 20-person limit includes the owner.
5. Marketing audience tabs, capacity selectors, comparisons, FAQs and links →
   new approved catalog. Keep covered access and Enterprise rollout inquiry.
6. Exercise the complete Stripe-to-workspace journey, then deploy with customer
   checkout off. The production request is recorded in the checklist above; verification
   still gates enabling paid checkout.

## Earlier prepared offer (superseded for new implementation)

- Explore is free. Its organization owns projects and shares AI capacity.
- Field is USD $600 per calendar month or $6,000 per year, equivalent to
  $500/month. Annual savings are $1,200 versus twelve monthly payments.
- Field includes up to 20 collaborators. Collaborator enforcement needs a
  separate audit before claiming the cap is technically enforced.
- Enterprise receives a custom annual quote for support and platform usage.
- ETEN affiliates and Bible-translation teams contact hello@aquilla.app to
  check covered access before paying. Coverage is confirmed by a human.
- No self-service add-on purchases, automatic overages, or mid-year allowance
  purchases are offered. Do not provision old add-on packs for this launch.

## Current implementation and launch gate

`BILLING_CHECKOUT_ENABLED` remains absent/false in the prepared configuration.
No deployment or deployed-secret changes occurred in this session. After this
change is deployed, both the billing snapshot and checkout endpoint consult the
same gate. Merely configuring Stripe does not enable purchasing.

New checkout uses only `STRIPE_PRICE_FIELD_MONTHLY` and
`STRIPE_PRICE_FIELD_ANNUAL`. It never falls back to the legacy four-week price.
Existing Stripe subscriptions and webhook processing remain intact.

The app billing screen shows the current plan, a disabled Coming soon upgrade,
covered-access contact, and usage guidance. Stripe-backed organizations retain
customer portal access. Organizations with covered access and no Stripe
customer receive no portal button.

## Usage: two different ledgers

The actual AI-cost controls are in `auth-worker/src/lib/credits.ts`:

- Usage belongs to the organization, with user attribution for accounting.
- Weekly means today and the preceding six UTC dates, not a Monday reset or
  a precise rolling 168-hour counter. Capacity returns as daily buckets age out.
- Daily limits and agent-specific daily/weekly limits can also apply.
- `CREDIT_ENFORCE` and per-organization `credits.enforce` determine whether
  exceeded limits block requests. Defaults are log-only. Verify deployed
  settings before announcing enforced caps.
- `credits.weeklyCap`, `dailyCap`, `agentWeeklyCap`, and `agentDailyCap` can be
  overridden per organization through the existing admin credit settings.
- Monetary billing cadence does not change this weekly accounting window.

The older word/Agent Credits ledger remains a separate accounting system. Its
28-day allowances and per-language calculations do not define the new offer.
Do not configure cost limits through the old billing credit catalog. Do not
promise that a plan assignment automatically supplies 10× weekly compute
capacity: the current cost configuration does not derive its caps from a plan.

## Verified sandbox catalog and portal

Account: Frontier R&D Ltd., `acct_1U47k85Mw0X7gcTS`, test mode.
The active product catalog was empty before preparation. On 2026-09-08:

- Created Aquilla Field: `prod_VE0arPBinZTim4`.
- Monthly: `price_1UDYZN5Mw0X7gcTSRgNbXJlH`, USD 60000 cents/month.
  Lookup key: `aquilla_field_usd_month_60000_2026_09`.
- Annual: `price_1UDYa35Mw0X7gcTSUQa6rIup`, USD 600000 cents/year.
  Lookup key: `aquilla_field_usd_year_600000_2026_09`.
- Saved default portal: `bpc_1UDYbl5Mw0X7gcTSI3aEOatn`. Invoice history,
  billing information, payment-method updates, and cancellation at period end
  are enabled. Plan switching and quantity changes are disabled.
- Prices exclude tax. No subscriptions, charges, live catalog changes, or
  application configuration changes were made in Stripe preparation.
- No webhook destinations existed. A form is prepared for
  `https://api.dev.aquilla.app/identity/api/v2/billing/webhook`, with snapshot
  payloads, API version `2026-07-29.dahlia`, and the four events listed below.
  Initially blocked by approval review; approval and creation are now complete.
  See the current webhook ID and disabled state above.
- No API or webhook secrets were retrieved or installed.
- Historical account observation (superseded by Ryder’s 2026-09-11 report of
  completed business verification; see the production checklist): activation
  was 10% complete. Business type displayed
  individual/sole proprietorship, which requires owner confirmation given the
  Ltd. name. Business details, products/services, public details, security,
  and review/submission remain unfinished. No activation form was submitted.

The older Obsidian note's price IDs belong to a different Stripe account suffix.
Verify account ownership and credentials before installing these new IDs.
For rerunning the sandbox script against this catalog, set
`STRIPE_FIELD_PRODUCT_ID=prod_VE0arPBinZTim4`; both lookup keys now exist.
The script validates supplied products and refuses to silently recreate a
missing supplied product in another account.

## Remaining Stripe integration preparation

1. Inspect the correct Aquilla account in sandbox/test mode. Record account ID,
   existing products, prices, webhook destinations, and portal configuration.
2. Create/reuse a Field product and two recurring USD prices: 60000 cents/month
   and 600000 cents/year, interval count 1. Never use a four-week interval.
   `scripts/stripe-setup.ts` provisions these in test mode, is rerunnable, and
   rejects live keys. It prints only price IDs, never secrets.
3. Set the two new price IDs for the target environment. Store the test secret
   and webhook signing secret using the normal secret manager, not source files.
4. Register the identity webhook at `/identity/api/v2/billing/webhook` on
   `api.dev.aquilla.app` for dev and `api.aquilla.app` for production. Subscribe
   to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, and `invoice.paid`.
5. Configure the customer portal for payment methods, invoices, and cancellation.
   Do not enable automatic plan/price switching until it is verified.
6. Keep production purchase gating off. Test with a local or isolated dev gate,
   never by activating customer-facing production checkout.
7. Confirm each cadence creates the right price and metadata (`orgId`, `kind`,
   `billingInterval`), then confirm signed webhooks update the owning org only.
8. Verify failed/unpaid checkout, duplicate webhook delivery, cancellation,
   renewal, portal access, and covered-access organizations before launch.
9. Provision equivalent live catalog and secrets only after the test flow works.
   Follow the current production checklist above before enabling paid checkout.

## Covered ETEN / Bible-translation access

1. Ask for the organization name, affiliation, and existing Aquilla org ID.
2. Confirm coverage with the commercial owner/ETEN liaison. Do not infer
   eligibility from an email domain or a checkbox.
3. Use the existing admin billing organization override to assign Field.
   This sets the plan active without creating a Stripe customer/subscription.
4. Configure the approved organization's cost caps separately in admin credit
   settings. Record the reason, agreement owner, and review date in the team’s
   commercial records; the existing admin change is audited.
5. Verify the organization sees Field and no payment/portal prompt. No payment
   method, coupon, or $0 Stripe subscription is required.
6. If an organization already pays through Stripe, coordinate its existing
   subscription before changing the plan. An admin override does not cancel
   its Stripe charges, and later webhooks can update the plan again.

## Enterprise deals and changes

Record the annual support/platform quote, scope, currency, tax treatment,
coverage dates, invoice schedule, and approved AI caps. Assign Enterprise using
the admin override and configure cost caps separately. Invoice according to the
signed agreement; the application does not generate these quotes or invoices.

If needs change, contact the commercial owner. There is no automated mid-year
allowance purchase or proration workflow. Agree any change before billing it.
Do not issue an invoice merely because a usage counter exceeds its setting.

## Remaining release checks

- Sandbox prices, portal, and disabled webhook are saved. Secrets,
  live catalog, business activation, and account-to-environment wiring remain open.
- Run a complete sandbox checkout and webhook/portal journey before enabling.
- Confirm deployed per-organization enforcement and approved capacity levels.
- Reconcile the legacy admin dollar-price editor before using it for future
  prices: it still creates legacy four-week prices, ignored by new checkout.
- The app upgrade selector defaults to annual and sends the selected interval
  through the prepared client/API. Coming soon remains disabled until launch.
- Reconcile both ticket worktrees, run affected checks, and use the full smoke
  suite at merge/deployment. Follow the current production checklist above.

## Verification in this working session

- Marketing: pricing component and preview tests (5 tests), plus `npm run build`.
- App: billing page (4 tests), billing client (4), client→request schema→price
  selection contract (3), sandbox provisioning (4), and billing worker routes
  (14). All pass. Worker TypeScript check passes.
- `npm run build` passes for the app worktree.
- The targeted `org-settings-billing.smoke.spec.ts` passes against the local
  Postgres/identity/sync/browser stack, with checkout still disabled.
- No slow-request lines appeared in the passing local browser run.
- The first browser test attempt failed because the sandbox blocked Chromium
  startup; the permitted run passed. No assertions were weakened.
- Browser access recovered. The marketing preview was inspected visually; the
  monthly toggle shows $600 and annual shows $500/month with $6,000 billed yearly.
  The weekly-reset FAQ opens and the covered-access link has the intended email.
- Sandbox catalog and portal changes are recorded above. No webhook, secret,
  deployment, or live changes occurred.
- Ticket status/assignment approval is complete. The earlier sibling-spec
  replacement remains unapplied and is superseded by the new pricing-model
  document. Do not apply `billing-spec-proposed.md` as the new offer.
- Changes are uncommitted and undeployed. App work lives in the AQU-837
  worktree; marketing changes remain in the requested marketing working copy.

## Test-impact record

The billing page consumes the billing snapshot and sends cadence through the
billing client. The checkout schema and price selector consume that request;
worker routes produce the Stripe checkout request. RTL, client, composition,
worker-route, and existing billing smoke coverage changed with this contract.
The sandbox script also tests matching dashboard-product reuse and rejects a
missing explicitly supplied product, preventing cross-account duplication.

Targeted commands run include:

- `npx vitest run scripts/stripe-setup.test.ts` (4 pass after browser recovery).
- `npm run build` in the marketing repo and app worktree (both pass).
- `tsc --noEmit -p auth-worker/tsconfig.json` (passes).
- `./node_modules/.bin/tsx scripts/e2e-up.ts -- e2e/specs/orgs/org-settings-billing.smoke.spec.ts`
  (passes against the local stack).
- `git diff --check` (passes after the sandbox reconciliation).

The full sandbox payment-to-webhook journey has not run. Local regression
coverage does not substitute for that external integration check.

### 2026-09-09 contract checks

`npx vitest run src/lib/billing/pricing-model.test.ts` in auth-worker passes
18 tests. `npx tsc --noEmit -p auth-worker/tsconfig.json` passes. The new tests
cover allowance/quantity rules, approved Stripe price → resolved offer
composition, personal/team classification, and anniversary boundaries. No new
smoke was added: this module is not connected to a product journey yet. Its
future integration must add the cross-layer tests described above before launch.

Calendar behavior follows Stripe's documented UTC month-end anchoring:
https://docs.stripe.com/billing/subscriptions/billing-cycle
Price validation uses the documented Price fields:
https://docs.stripe.com/api/prices/object

The app `npm run build` also passes after adding the new contract module.
No deployment, customer migration, or purchase activation occurred.

### Approved baseline and cohort test impact

Changed contracts: provisioning responses → approved manifest → composed offer
quote → analytics properties; experiment selection → persisted workspace cohort
→ first rendered exposure. The Stripe baseline composition tests cover both
cadences, Team platform quantity one, capacity totals, unavailable prices,
rerun idempotency, changed-price rejection, and stable entitlements across price
variants. PGlite integration tests cover concurrent cohort assignment, stable
assignment after weight/eligibility changes, workspace isolation, disabled tests,
and idempotent first exposure.

Commands run for these changes:

- Root: `npx vitest run scripts/stripe-pricing-baseline.test.ts scripts/stripe-setup.test.ts`
  — 7 tests pass.
- auth-worker: `npx vitest run src/lib/billing/pricing-model.test.ts src/lib/billing/price-cohorts.test.ts`
  — 21 tests pass.
- Root: `npx tsc --noEmit -p auth-worker/tsconfig.json` — passes.
- Root: `npm run build` — passes.

No smoke journey changed in this increment: the new quote/cohort modules are not
wired into customer routes yet. Product-level payment/retention integration
requires its own boundary tests before launch. Stripe UI verification confirmed
all new prices' IDs, USD amounts, month/year interval count 1, licensed usage,
and sandbox mode. No automated sandbox payment was run.
