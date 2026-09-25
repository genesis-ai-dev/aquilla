# Stripe launch and covered-access playbook

Updated: 2026-09-17. Tickets: AQU-837 (billing readiness), AQU-1091 (pricing and app UI).

## Deployed sandbox on dev — 2026-09-17

Stage 1 of the live switch: run the real Stripe **sandbox** against the deployed
`dev` environment so the payment → webhook → workspace access → portal journey
is exercised on real hosts before any live key exists.

- [x] The sandbox gate accepts two shapes only: wrangler-local loopback (as
  before), or `ENVIRONMENT=development` with the request host and the app
  return origin listed in `BILLING_SANDBOX_HOSTS`. Both still require
  `BILLING_WORKSPACE_CHECKOUT_REHEARSAL=true` and an `sk_test_`/`rk_test_`
  key. Production (`ENVIRONMENT=production`, live key) cannot satisfy it even
  if the vars are copied. Success, cancel, and portal return URLs use the
  allowlisted app origin, never a browser-provided URL.
- [x] `wrangler.toml` `[env.development.vars]` sets the flag and
  `BILLING_SANDBOX_HOSTS = "api.dev.aquilla.app,dev.aquilla.app"`.
- [ ] Install the dev secrets (Ryder): `wrangler secret put <NAME> --env
  development` for `STRIPE_SECRET_KEY` (sandbox `sk_test_…`),
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CATALOG` (paste
  `config/pricing/stripe-sandbox-native.json`), and the two
  `STRIPE_PORTAL_*_CONFIGURATION` ids from `config/pricing/stripe-sandbox-portal.json`.
- [ ] In the Stripe sandbox dashboard add a webhook endpoint
  `https://api.dev.aquilla.app/identity/billing/webhook` with events
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`; its signing secret is the
  `STRIPE_WEBHOOK_SECRET` above.
- [ ] Deploy `dev` (the guarded repository deploy commands), then run the
  journey below. Record the outcomes in this runbook.

Journey (the SPA has no checkout button yet; start checkout through the API):

```sh
API=https://api.dev.aquilla.app/identity
JWT=$(curl -s -X POST $API/api/v2/auth/token -H 'Content-Type: application/json' \
  -d '{"username":"<you>","password":"<pw>"}' | jq -r .access_token)
ORG=<your personal workspace id from GET $API/api/v2/orgs/me>
# 1. Review the offer; copy priceVersion, offer.totalAmount, offer.currency.
curl -s -X POST $API/api/v2/orgs/$ORG/billing/review -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"offer":"pro","interval":"month","quantity":1}'
# 2. Start sandbox checkout; open the returned url in a browser and pay with 4242 4242 4242 4242.
curl -s -X POST $API/api/v2/orgs/$ORG/billing/checkout-rehearsal -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"offer":"pro","interval":"month","quantity":1,
  "confirmedPriceVersion":"<priceVersion>","confirmedTotalAmount":<totalAmount>,"confirmedCurrency":"usd"}'
# 3. Stripe posts the signed event to dev; then the workspace shows the plan:
curl -s $API/api/v2/orgs/$ORG/billing/workspace -H "Authorization: Bearer $JWT"
# 4. Manage billing in the app (Settings → Billing) opens the sandbox portal;
#    upgrade to Max 5×, then cancel, and re-read the workspace after each webhook.
# 5. If a session expires or is abandoned:
curl -s -X POST $API/api/v2/orgs/$ORG/billing/checkout-rehearsal/reconcile -H "Authorization: Bearer $JWT"
```

Delayed-payment and 3DS cases use Stripe's test cards (`4000 0025 0000 3155`
for 3DS, `4000 0000 0000 0341` for a failing attach). Weekly metering on dev is a
separate switch: set `BILLING_WEEKLY_USAGE_ENFORCE=true` on dev only if you
also want percentages and enforcement exercised against real provider cost.

Test impact: the checkout suite adds the deployed-sandbox case (faithful dev
bindings pass the environment guard; production environment, an unlisted API
host, a live key, an unlisted app origin, and a missing allowlist each fail
closed) — 87 pass; portal, change, and webhook recovery suites pass (156 total);
deployment contract and config tests pass (73). Worker lint and tsc pass.

## Segmentation metering and weekly-stop client copy — 2026-09-17

- [x] Merge the dev-synced billing branch (f64a43ce8); conflicts resolved in
  the draft context, schema, journeys, and env example.
- [x] Meter `POST /:projectId/contextual/segmentation/generate` through the
  same `makeLlmCall` admission; a spent week answers 429
  `weekly_ai_allowance_exhausted` and unpriced/unavailable accounting 503,
  instead of storing a silently degraded whole-file segmentation. Usage
  refusals now propagate out of the segmentation pass; other call failures
  still keep the surrounding passage whole.
- [x] The agent client understands `budget.exhausted` with
  `reason: "weekly_allowance"`: the meter shows a weekly-allowance stop with no
  credit figures and notes that staged work is kept (`agent.budget.weeklyExhausted`).
- [x] Knowledge indexing and Monday analysis are classified platform-funded
  (bounded, not user-selectable, org-scoped); see the usage map. Every
  producer is now metered or explicitly classified. Ryder to confirm.

Test impact: autopilot usage suite adds the segmentation case (4 pass);
segmentation, contextual route, and tick suites pass (83); BudgetMeter adds
the weekly case; agent client and i18n suites pass except two i18n catalog
checks that already fail on the merged HEAD (`onboarding.connect.account`
placeholder documentation, from dev), unrelated to the new key.

## Enforcement mode and legacy guard retirement — 2026-09-16

- [x] One policy module (`lib/billing/usage-mode.ts`) decides metering for
  every producer: `off` (default), `rehearsal` (`BILLING_CHAT_USAGE_REHEARSAL`,
  wrangler-local with loopback request and provider only, fails closed
  elsewhere), and `enforce` (`BILLING_WEEKLY_USAGE_ENFORCE=true`, any provider).
- [x] A metered call retires the legacy ledgers for itself: chat, import
  classification, agent runs, and autopilot starts skip `creditGuard`,
  `wordGuard`, `recordCredit`, and `recordWords` when the weekly ledger admits
  them. Unmetered calls (mode off, segmentation generation, indexing, Monday)
  keep the legacy guards until they are connected.
- [ ] Enabling `enforce` in a deployed environment is a launch decision: it
  requires the production catalog, migrations 0097 and 0098 applied, and the
  reconcile sweep. Delete the legacy guard code and admin credits panel only
  after enforcement is live and no producer still depends on them.

Test impact: new `billing-usage-mode.test.ts` (two unit tests covering off,
rehearsal gates, and enforce precedence); the chat suite adds an enforce-mode
case against a live provider URL proving the legacy tables stay empty for a
metered call and still fill when metering is off. All metered producer suites
(33) and off-mode suites for chat, classify, agent, autopilot, and workspace
(83) pass. Worker lint and type checks pass.

## Measured usage percentage — 2026-09-16

- [x] The billing workspace API reports `usagePercent` (whole percent of the
  current week's settled plus reserved usage against the same allowance and
  period admission uses, capped at 100) and `usageResetsAt` (exact reset
  instant). Explicit Free workspaces measure from creation; paid workspaces
  from activation. Legacy, covered, and unconfirmed workspaces stay `null`,
  and a ledger outage leaves the field absent rather than zero.
- [x] The workspace billing card shows "N% of this week's AI allowance used"
  with the reset time when measured, and keeps the previous period-only copy
  otherwise. No credit counts or internal units are exposed.
- [x] Frontend `budget.exhausted` handling for the `weekly_allowance` reason
  (2026-09-17 checkpoint). Percentage in exhaustion errors and onboarding copy
  remain open.

Test impact: ledger suite adds a summary case (96% reserved, 100% capped
overrun, null for legacy); the chat suite asserts the API percent after real
settlement; checkout and workspace route expectations move from `null` to a
measured 0 with the reset instant (115 + 15 pass). RTL adds the percentage
copy case (24 pass). The summary component already had 16 pre-existing
unkeyed-string lint errors on HEAD; this adds the new string in the same style.

## Autopilot cost-ledger integration — 2026-09-16

- [x] Meter every contextual graph call (construe, summarize, draft, verifiers)
  as its own step through `makeLlmCall`'s new `admit` hook: reserve the
  live-card bound with the call's own `maxTokens` before the request, settle
  the reported cost after, hold on transport/HTTP failure. Retries within one
  call share one reservation; capacity rejections are not charged.
- [x] Fund background and sweeper-resumed runs from the run's persisted role
  snapshot owner and the project's workspace; metering on with no owner, no
  workspace, or a non-local provider fails the run rather than running unmetered.
- [x] Exhaustion requests a pause; the tick confirms `paused` at the next span
  edge and staged drafts stay reviewable. Spans already in flight in that wave
  fail their remaining calls with `usage_exhausted` and are reported as failed.
- [ ] Resume after the weekly reset is manual (Play). Segmentation generation
  is metered (2026-09-17); knowledge indexing and Monday analysis remain
  unconnected; the per-run cap remains as a safety ceiling.

Test impact: new `billing-contextual-usage.test.ts` (three real-Postgres route
tests: owner-funded settlement of every graph call with provider refs, pause on
a spent week without a provider call, unowned/non-local refusals). Existing
contextual route and tick suites pass (49). Worker lint and type checks pass.

## Agent per-step cost-ledger integration — 2026-09-16

- [x] Meter every paid agent model call as its own step under the same local
  rehearsal gate: the orchestrator turn and both nested drafting passes each
  reserve their live-card bound before the call and settle their reported cost
  (`lib/billing/agent-usage.ts`; `upstream.ts` now captures the generation id).
  Metered calls carry the 4096 output cap.
- [x] Exhaustion stops the next step, never work already done: the run ends
  `capped` with a `budget.exhausted` frame carrying `reason: "weekly_allowance"`,
  a refused drafting pass returns a tool error, and staged proposals survive.
- [x] Provider errors, transport failures, and missing cost hold the step's
  reservation (with its generation id when known) for reconciliation. Unpriced
  models end the run with `model_price_unavailable`; unowned projects get 403.
- [x] Legacy per-run credit/word guards are skipped for metered runs (see the
  enforcement-mode checkpoint); the per-run cost cap remains as a safety ceiling.

Test impact: new `billing-agent-usage.test.ts` (five real-Postgres route tests:
settled turns with provider refs, nested drafting steps, exhaustion before the
provider, mid-run drafting refusal at exactly 100%, held/unpriced/unowned
cases). Existing agent route, harness, upstream, tools, and command suites pass
(52). Worker lint and type checks pass. The agent route and its upstream/draft
modules join the billing impact mapping.

## Live rate card and reservation bound — 2026-09-16

- [x] Replace the fixed one-cent rehearsal reservation with a bound priced from
  OpenRouter's live model list (`rate-card.ts`, cached ten minutes per provider):
  prompt characters ÷ 2 as tokens plus the enforced output cap. Metered chat
  caps `max_tokens` at 4096 server-side; classify uses its fixed 1,200.
- [x] Refuse a model missing from the live card (`model_price_unavailable`,
  503) before any provider call. Prices are never estimated or defaulted.
- [x] Admission rule per the 2026-09-16 decisions: nothing starts at or past
  100% of the weekly allowance; a bounded request may end up to 5% over.
  Settlement records the true cost; customers only ever see 100%.
- [x] The loopback rehearsal gate is now one of three modes; `enforce` opens
  any provider behind an explicit flag (enforcement-mode checkpoint).

Test impact: new `billing-rate-card.test.ts` (four unit tests: bound math,
unknown model, cache TTL, malformed cards) and an overage case in the ledger
suite (17). Chat (13), import (5), and reconcile (6) suites now script the
model list through `helpers/rate-card.ts` with exact binary prices so reserved
totals assert as integers. Unmetered classify and chat guard suites pass (19).

## Held-usage reconciliation — 2026-09-16

- [x] Persist the provider generation id (`provider_ref`) on usage requests.
  Chat records it from JSON `id` or the first SSE chunk `id`, including on
  missing cost, truncated streams, and client cancellation; import
  classification inherits it. A reference never settles or releases usage.
- [x] Reject a conflicting reference instead of rebinding a request to a
  different generation. Migration `0098_workspace_usage_provider_ref.sql` is
  prepared, not deployed, and replays without losing held usage.
- [x] Add local-only maintainer endpoints under the chat rehearsal gate:
  `GET /orgs/:orgId/billing/usage-rehearsal/held` lists held reservations and
  `POST .../usage-rehearsal/reconcile` settles one from the provider's
  generation record (`{ data: { id, total_cost } }`). Provider errors, id
  mismatch, malformed cost, or a missing reference keep the reservation held.
- [ ] Reconcile against the real OpenRouter generation endpoint once the live
  provider gate opens; automate a sweep of held requests older than a bounded
  age instead of manual maintainer calls.

Test impact: new `billing-usage-reconcile.test.ts` (six real-Postgres route
tests) covers held JSON and stream requests, exactly-once settlement, unreferenced
and unavailable records, reference conflicts, gate/role/404 handling, and
migration replay. Chat (13), import (5), ledger (16), portal/checkout (115), and
impact/determinism (24) suites pass; worker lint and secret scan pass. The
migration joins the billing impact list. No UI or browser behavior changes.

## Import-classification cost-ledger integration — 2026-09-16

- [x] Connect `POST /api/v1/import/classify` to the same local scripted-provider
  rehearsal gate, reservation, and settlement as chat. Project-lead authority
  and legacy guards run first; unowned projects (org 0) are rejected, never funded.
- [x] Settle reported provider cost before validating the recipe: a charged
  malformed or unsafe recipe still consumes allowance. Upstream errors and
  missing cost keep the reservation held for reconciliation.
- [x] Same-key retries return 409 without another provider call; a new key
  reserves again. Manual import and the legacy credit/word ledgers are unchanged.
- [ ] Remaining producers: agent runs and nested drafting, contextual background
  work, import sandbox conversion, knowledge indexing, Monday analysis, and
  speech in sync-worker. The three open chat items above still apply here.

Test impact: new `billing-import-usage.test.ts` (five real-Postgres route tests)
runs under the same webhook-postgres config; the existing classify suite (mocked
provider, rehearsal off) is unchanged. `scripts/lib/e2e-impact.ts` now maps the
classify route to the billing journey. No UI or browser behavior changes.

## Chat cost-ledger integration — 2026-09-14

- [x] Connect the authenticated chat handler to durable weekly admission and
  actual-cost settlement for local scripted-provider rehearsal. No separate
  shadow implementation bypasses the normal authentication or project roles.
- [x] Reject missing, unknown, and unauthorized project ownership instead of
  falling back to the legacy unowned pool when usage rehearsal is enabled.
- [x] Reserve before calling the provider; return 429 on exhausted allowance and
  409 on a repeated idempotency key without making another provider request.
- [x] Settle non-streaming provider cost and bounded, backpressured SSE streams.
  Preserve response bytes. Settle before forwarding `[DONE]`, since the real
  client returns at that frame without waiting for transport EOF.
- [x] Preserve reservations for unknown/malformed cost, truncated streams,
  cancellation, and uncertain provider failures. Valid generated content survives
  accounting failure. Missing cost never becomes a fabricated flat charge in the
  new weekly ledger; the legacy parallel ledger remains separate.
- [x] Keep real providers and deployed origins outside this rehearsal. The flag
  `BILLING_CHAT_USAGE_REHEARSAL=true` requires `WRANGLER_LOCAL=1` and loopback
  request/provider URLs. Its one-cent reservation is for scripted local tests,
  not a validated upper bound or estimated bill for a real provider.
- [x] Validate server-owned real-provider cost bounds and model routing before
  enabling actual funded-provider enforcement. Bound now comes from the live
  rate card (checkpoint above); routing stays server-owned. Gate unchanged.
- [x] Persist provider generation references and verify reconciliation of held
  requests after interrupted delivery or persistence failure. See the
  held-usage reconciliation checkpoint above; live-provider sweep still pending.
- [ ] Connect agent, background/contextual work, imports, and speech to the same
  ledger; complete capability checks and authoritative usage percentages.
  Agent, import classification, and autopilot are connected (checkpoints
  above); speech is unmetered by decision; percentages and legacy guard
  retirement remain.

Test impact: new `billing-chat-usage.test.ts` composes signed Checkout activation
with the actual authenticated chat route, provider-shaped JSON/SSE responses, and
real Postgres reservations/settlement. It covers fragmented UTF-8/SSE, immediate
client completion at `[DONE]`, cancellation, missing cost, exhausted allowance,
unauthorized scope, duplicate execution, and unsafe rehearsal configuration.
Thirteen route tests plus sixteen ledger tests pass (29 total). Existing chat
allowlist/attribution tests pass (14). Provider transport is scripted, not live.

Commands: `pnpm --dir auth-worker exec vitest run --config
vitest.webhook-postgres.config.ts src/__tests__/billing-chat-usage.test.ts
src/__tests__/billing-workspace-usage.test.ts`; `pnpm --dir auth-worker exec
vitest run src/__tests__/chat-guard.test.ts --maxWorkers=2`.
The billing browser sentinel preserves current app access; it does not claim
end-to-end live-provider enforcement. Worker type checking, production build,
impact/determinism checks (24 pass), and targeted billing smoke (three pass,
no slow-request logs) pass. `pnpm scan:secrets` and `git diff --check` also pass.
No deployment or live-provider call occurs.

## Native hosted billing implementation — 2026-09-14

This checkpoint supersedes the limited portal configuration and custom paid-plan
review UI below. Everything remains sandbox-only and gated to local rehearsal.
Production payments and deployed configuration remain unchanged.

- [x] Provision and read-verify all ten approved monthly/annual prices in the
  separate admin sandbox. `config/pricing/stripe-sandbox-native.json` records
  one Product per offer and one subscription item, quantity one. Team20× bundles
  the approved $720/month or $7,200/year total; no commercial price changes.
- [x] Create and read-verify personal/team native portal configurations. See
  `config/pricing/stripe-sandbox-portal.json`; limited configurations remain
  recorded separately. Every product explicitly disables adjustable quantity.
- [x] Verify actual Stripe-hosted personal upgrade, downgrade, and cancellation.
  Pro → Max5× charges $40 immediately in the sandbox. Max5× → Pro takes effect
  immediately and creates a $40 account credit, with no automatic cash refund.
  Renewal date stays unchanged. Cancellation preserves the paid period.
- [x] Adopt that native downgrade policy, under the approved Stripe-native
  fallback. Stripe displays the timing and credit before confirmation.
- [x] Reconcile native changes against current Stripe subscription, approved
  catalog, and settled invoice. Reject scope changes, unapproved prices,
  quantity changes, and mismatched proration proof. Preserve the usage anchor.
- [x] Handle actual API shapes: paid invoices may omit `paid`; scheduled
  cancellation may use `cancel_at` while `cancel_at_period_end` remains false.
- [x] Connect the paid workspace **Manage billing** surface to the authorized
  hosted portal. Remove its custom plan-review entry point. Keep old backend
  review code checkpointed until the remaining lifecycle cases pass.
- [x] Complete real sandbox Checkout → Stripe CLI signed webhook → local Hono
  handler → disposable Postgres activation, then hosted Pro → Max5× upgrade.
  The stored plan changes and its weekly usage anchor stays unchanged.
- [x] Reproduce early invoice delivery and overlapping updates at the signed
  webhook/Postgres boundary. Both return retryable failures before successful
  replay; duplicate successful deliveries leave revision and usage unchanged.
- [ ] Verify actual Stripe redelivery after an endpoint failure. The real CLI
  run observed two HTTP 500 deliveries; regression tests prove recovery using
  signed fixture replay, not automatic Stripe redelivery. Do not conflate them.
- [ ] Exercise real Team plan changes, failed payment/3DS recovery, monthly/annual
  switches, renewal, and final cancellation expiry before live enablement.
- [ ] Retire unused custom plan-review backend/persistence after hosted coverage.
- [ ] Wire weekly metering and enforcement through every AI execution path.
  Preserving the usage anchor does not establish that usage is measured/enforced.
- [x] Map existing AI producers and accounting gaps in
  [weekly usage implementation](weekly-usage-implementation.md).
- [x] Resolve the accounting basis: provider cost with the same multiplier for
  agent and other tools. Version `2026-09-cost-v1` uses 4× and internal marked-up
  cents; approved allowance counts stay unchanged. Validate workload capacity
  before enforcement: Pro currently maps to 12.5 raw provider cents/week.
- [x] Implement the durable cost reservation/settlement foundation with exact
  weekly periods, rate snapshots, idempotency, and atomic admission. Sixteen
  real-Postgres tests pass. See the usage implementation map for boundaries.
- [ ] Connect every funded endpoint to admission/settlement, verify streamed and
  background work, and expose measured percentage usage. The foundation has no
  production callers yet; it does not establish end-to-end enforcement.
- [ ] Resolve migration numbering against current main, then run release gates.
- [ ] Provision and validate the production catalog, portal settings, endpoint
  signing secret, tax configuration, and controlled live rollout separately.
- [ ] Dispatch the dedicated pricing-aware onboarding rework and finish Team
  membership/reviewer limits before advertising those capabilities as complete.

Verification evidence:

- Actual sandbox subscription `sub_1UFaeo7SR91OrWMSGzwSpA6K` activates Pro and
  upgrades to Max5× through original CLI-forwarded Stripe signatures. The local
  harness passes (one test). It uses actual application handlers and disposable
  Postgres; the browser return page is a verification page, not the full SPA.
- Captured Stripe lifecycle/configuration fields in worker fixtures exercise
  the producer → parser → transaction → workspace response boundary. Fixtures
  contain no signing secrets, payment details, or session URLs.
- Worker targeted checks pass: 159 tests across native catalog/lifecycle,
  checkout, change review, and portal; additional targeted checks pass after
  capability/rollback additions. Real Postgres gate passes 174 tests across
  seven files before the two new recovery regressions; the updated native
  lifecycle file passes all nine tests against real Postgres.
- RTL/client/impact/determinism checks pass (55 tests); the final billing summary
  and settings check passes 23 tests. Existing billing smoke plus the temporary
  visual probe pass four browser tests; the final visual probe passes after
  the copy correction. The temporary probe is removed; RTL retains coverage.
- Commands: `pnpm --dir auth-worker exec vitest run --config
  vitest.webhook-postgres.config.ts`; targeted recovery adds
  `src/__tests__/billing-native-lifecycle.test.ts`. Worker tests use their named
  files; RTL uses `npx vitest run ... --maxWorkers=2`. Browser checks use
  `E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts --
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts ... --shard=1/1`.
- `pnpm --dir auth-worker exec tsc --noEmit`, `npm run build`, and
  `git diff --check` are the final local gates. Full release smoke remains
  required at merge/deploy; no deployment occurs in this checkpoint.

## Correct admin sandbox and local credentials — 2026-09-14

Ryder confirms the verified admin@frontierrnd.com account mapping:

- Production account: `acct_1U47k85Mw0X7gcTS`.
- Separate sandbox: `acct_1U47kG7SR91OrWMS`.

The current `stripe-sandbox.json` records the production account ID alongside
historically test-mode prices. That does not establish these are live prices:
Stripe's account test mode and a separate sandbox are different environments.
Do not relabel historical objects as live or assume they exist in the separate
sandbox. The old catalog must not be enabled using the separate sandbox key.
This correction supersedes earlier references calling that account our sandbox.

Direct authenticated reads verify the separate sandbox contains only the legacy
Field Plan (`price_1U487L7SR91OrWMSAwgtPRxU`, $500 every four weeks) and one-time
capacity add-on (`price_1U487M7SR91OrWMStnLewx15`, $200). Product/price listings are
complete, not truncated. No newer Pro/Max/Team prices, webhook endpoints, or portal
configurations existed there before this step. No live API requests were made.

- [x] Verify exactly one active sandbox secret/publishable key in the main
  auth-worker local environment and validate its account through Stripe.
- [x] Copy only sandbox credentials into the AQU-837 worktree's ignored
  `auth-worker/.dev.vars`; no secret enters source control or tool output.
- [x] Obtain the local Stripe CLI signing secret and save it as
  `STRIPE_WEBHOOK_SECRET` in that worktree file. This is for CLI forwarding,
  not the separate development/production endpoint signing secret.
- [x] Create and read-verify personal/team sandbox portal configurations with
  invoice history and payment-method updates enabled, subscription update and
  cancellation disabled. IDs and allowed features are recorded in
  `config/pricing/stripe-sandbox-portal.json` and the ignored local environment.
- [x] Build/verify the Stripe-native Pro/Max/Team catalog in this separate sandbox;
  replace the account and all relevant Price/Product bindings together. Do not
  simply replace the old account ID while retaining its Price IDs.
- [x] Start a local Stripe CLI listener against the explicitly configured local
  worker, verify its signing secret matches, and exercise actual event delivery.
  Secret retrieval alone does not mean a listener is running or webhooks pass.
- [x] Verify real personal checkout/portal upgrade and resulting workspace access.
  Remaining lifecycle/Team cases are listed above.

Portal configurations: personal `bpc_1UFa3g7SR91OrWMS1h3q73NA`,
team `bpc_1UFa3g7SR91OrWMSwwoRyyWP`. Stable idempotency keys protect creation
retries. Configurations are test-mode and active. Local feature flags and the
new catalog are not enabled by installing credentials. No subscriptions, charges,
live objects, or deployed worker configuration changed.

Validation: real Stripe account/catalog/configuration API responses and
`git diff --check`. This checkpoint changes operational documentation and adds an
informational portal manifest; runtime producers/consumers and tests do not change.
Earlier mocked tests remain distinct from real payment/portal journey evidence.

## Stripe-hosted billing direction — 2026-09-13

Ryder approves using Stripe for every supported billing operation and modest
policy adjustments that fit standard Stripe behavior. This supersedes the plan
to build custom plan-change confirmation, proration, and schedule execution.
Earlier custom-review evidence remains historical; it is not a launch requirement.
The existing custom review code is checkpointed in `811cdb474`, not deployed.

Ownership:

- Stripe Checkout handles the first purchase.
- Stripe Customer Portal handles plan changes, proration confirmation, payment
  authentication, payment methods, invoices, and cancellation where supported.
- Stripe Billing handles recurring collection, retries, and billing schedules.
- Aquilla authorizes workspace maintainers, maps verified Stripe state to access,
  and measures/enforces weekly usage without resetting consumption on plan changes.
- Redirects from Stripe never grant access; verified server-side state does.

Prefer a simple fixed-price, single-item subscription for each launch offer,
with quantity one and separate personal/team portal configurations. Preserve
approved commercial totals; a simpler catalog representation is not a price change.
Keep existing catalog IDs and historical subscriptions readable during transition.
Do not copy sandbox objects wholesale into live mode.

Policy selection must follow an actual sandbox proof. Prefer immediate prorated
upgrades and cancellation at period end. Retain renewal-time downgrades wherever
Stripe supports them natively. If the launch catalog cannot support that directly,
use immediate prorated downgrades, with Stripe displaying the timing and credit
before confirmation. Record the selected behavior and update product copy/specs
before enabling it. Credits do not imply automatic cash refunds. Weekly usage
remains consumed when the cap changes. Do not build a custom scheduling engine
solely to preserve the earlier downgrade preference.

Stripe documents renewal-time downgrades only between Prices on the same Product.
Its portal also restricts duplicate Product/recurring-interval Price choices.
Our current Max variants share a Product and interval; Pro uses another Product.
Team20x has two items on one Product: test it explicitly rather than treating it
as the documented multiple-Product restriction. A new single-item bundled Price
is the preferred fallback if that composition prevents native management.

Execution checklist, in dependency order:

- [x] Record approval for Stripe-hosted billing and retire custom execution as
  the default implementation plan.
- [x] Preserve implementation checkpoint and recover the temporary checkout.
  Its Git link and 3,803 missing tracked files were restored from `811cdb474`;
  surviving files matched HEAD and were not overwritten. Git reports clean
  before this documentation update. No committed work was lost.
- [ ] Prove a real sandbox portal configuration against personal and Team offers:
  upgrades, downgrade timing/credit, failed payment/3DS, cancellation, and recovery.
- [x] Finalize the minimal supported catalog and portal settings; record IDs and
  exact policy outcomes. Do not mark mocked Stripe responses as this proof.
- [x] Add the local sandbox workspace portal-session endpoint using the stored
  customer, explicit scope-specific configuration, and trusted return URL.
  This slice supports invoices/payment methods only; see evidence below.
- [x] Connect the paid billing UI to the verified portal configuration and enable
  subscription management only after the real sandbox/lifecycle proof.
- [ ] Reconcile portal-originated Price changes and paid access from verified
  Stripe state. Cover prorations, pending payment, scheduled changes, cancellation
  timestamps, duplicate/out-of-order webhooks, and unchanged weekly consumption.
- [ ] Replace the custom review surface with hosted billing management; retire
  unused preview/persistence code after the replacement passes its tests.
- [ ] Complete actual weekly metering/enforcement across AI execution paths.
- [ ] Update pricing/onboarding copy and behavior specs to the verified rules.
  The dedicated pricing-aware onboarding rework still needs dispatch.
- [ ] Run affected worker/Postgres/RTL/billing smoke coverage and the build;
  complete real sandbox checkout-to-portal-to-access tests before live enablement.

Documentation-only validation for this decision: `git diff --check`. No runtime
contract, producer/consumer, or test changed in this checkpoint. Earlier passing
tests do not establish portal compatibility. Live checkout remains disabled.

Sources checked 2026-09-13:
[Portal configuration](https://docs.stripe.com/customer-management/configure-portal),
[portal limitations](https://docs.stripe.com/customer-management), and
[hosted confirmation flows](https://docs.stripe.com/customer-management/portal-deep-links).

## Hosted workspace portal connection — 2026-09-13

AQU-837 adds `POST /api/v2/orgs/:orgId/billing/portal-rehearsal`.
It requires authenticated maintainer authority, the existing explicit local
checkout-rehearsal flag, a test key, and a loopback request/return origin.
`STRIPE_PORTAL_PERSONAL_CONFIGURATION` and `STRIPE_PORTAL_TEAM_CONFIGURATION`
select explicit server-owned configurations. No default portal is assumed.

The endpoint reads the persisted entitlement and checkout account, verifies the
current Stripe subscription/customer and configuration, and creates a hosted
session. Browser-supplied customer/configuration/return URL values have no effect.
Shared legacy/other-workspace customers require reconciliation. Responses are
not cached; errors never expose Stripe messages or unverified session URLs.

This incremental configuration requires invoice history and payment-method
updates enabled, with subscription updates and cancellation disabled. It does
not alter the approved cancellation policy; those actions remain a later slice.
Failed-payment users can reach payment settings without this endpoint restoring
access. No billing or usage state is written, and the paid UI is not connected yet.
The existing default sandbox portal may allow cancellation: do not pass its ID
without creating/verifying a configuration matching this limited slice.

The new regression suite passes real checkout and signed activation output into
portal creation through the database. It covers personal/Team selection, access
control, malformed IDs, local-only gating, account/customer/configuration mismatch,
unsafe session URLs, shared customers, failed-payment access, and no state writes.
29 focused tests pass with PGlite; the same 29 pass against real Postgres.
The three existing billing browser journeys pass after granting Chromium its
required macOS launch permission; the first attempt failed before browser launch.
No slow-request log entries appear. Worker TypeScript and `npm run build` pass.
Behavior spec checkpoint: `d9dc1bc`.

Commands run for this slice:

```sh
pnpm --dir auth-worker exec vitest run \
  src/__tests__/billing-workspace-portal.test.ts --maxWorkers=2
pnpm --dir auth-worker exec vitest run \
  --config vitest.webhook-postgres.config.ts \
  src/__tests__/billing-workspace-portal.test.ts
pnpm --dir auth-worker exec tsc --noEmit
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```
The billing journey inventory records this boundary. Existing impact selection
already selects billing source files; no new sentinel is required.

Real Stripe verification remains pending: both browser-connection attempts time
out and neither checked auth-worker environment contains a configured Stripe key.
No real session, purchase, catalog change, deployment, or live configuration occurs.

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

### Subscription policy and lifecycle checkpoint (2026-09-11)

Ryder approves immediate Free fallback after failed payment, retained access for
already-paid time after cancellation, and immediate upgrades. On 2026-09-12,
Ryder supersedes the earlier immediate-downgrade decision: downgrades take effect
at the next billing cycle. Upgrades charge the prorated difference immediately.
Plan changes preserve this week's consumption; upgrades raise the cap rather than
refilling it. The existing plan and cap remain in force until a scheduled downgrade
takes effect. At that point, usage above the lower cap leaves no remaining allowance
until the next weekly reset.

- [x] Persist verified payment failure, paid-through, and cancellation facts in
  migration `0095_workspace_subscription_state.sql` (prepared, not deployed).
- [x] Reconcile signed local sandbox renewal, failure, recovery, subscription
  update, and cancellation events against current Stripe subscription/invoice
  reads. Match account, customer, subscription, price IDs, and paid periods.
- [x] Commit lifecycle facts and webhook receipt atomically. Reject a concurrent
  stale read by revision, roll back its receipt, and permit a fresh retry.
- [x] Preserve the usage anchor through lifecycle events and preserve already-paid
  time after cancellation. Free fallback applies at the exact paid-through boundary.
- [x] Expose effective allowance state through the workspace API and billing page.
  Subscription identity stays visible while the page explains Free fallback.
- [x] Define remaining allowance as `max(0, current cap - this week's usage)`;
  test failure fallback, recovery, upgrades, and over-cap downgrades.
- [ ] Connect the effective allowance to timestamped usage accounting and AI
  request enforcement. The calculation is tested; it does not yet gate AI calls.
- [ ] Implement reviewed immediate upgrades with an immediate prorated charge,
  and schedule downgrades for the next billing cycle. Grant an upgrade after its
  payment succeeds; retain current weekly usage. Keep the current plan and cap
  until the scheduled downgrade takes effect. Changed Stripe price sets remain
  retryable until this implementation is verified.
- [ ] Reconcile any older rehearsal entitlement without a verified paid-through
  date. Migration 0095 never invents dates or classifies existing billing.

Initial signed payment records the subscription's verified paid period. Renewals
extend that period only from a paid invoice matching the current subscription
items and their periods. Failed invoices can trigger Free fallback even when
Stripe still reports an active subscription. Delayed notifications read current
Stripe facts; they do not replay obsolete event payloads over recovered access.
Canceled subscriptions retain the last proven paid-through date. Existing Field
and covered-access records remain outside this new-plan path.

The local rehearsal gate, signature requirement, and disabled production checkout
remain in place. No live Stripe changes, new billing charges, deployment, or
release smoke gate occurs in this checkpoint. External Stripe responses are mocked.

Verification: 124 worker tests, 100 real-Postgres tests, 46 UI/supporting
tests, and all three billing browser journeys pass. Worker TypeScript and the
production build pass. Browser output contains no slow-request warnings.

Verification commands:

```sh
pnpm --dir auth-worker exec vitest run \
  src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace-migration.test.ts \
  src/__tests__/billing-workspace.test.ts \
  src/lib/billing/pricing-model.test.ts --maxWorkers=2
pnpm --dir auth-worker exec vitest run \
  --config vitest.webhook-postgres.config.ts
npx vitest run src/pages/settings/OrgSettingsBilling.test.tsx \
  src/components/org/BillingWorkspaceSummary.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2
pnpm --dir auth-worker exec tsc --noEmit
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```

Test contract: review/checkout → signed payment → lifecycle reconciliation →
Postgres → workspace API. Browser tests additionally consume persisted failure
facts through the API and show Free allowance with usage retained. Regression
cases include duplicate and delayed delivery, concurrent stale reads, rollback,
wrong account/customer/price/invoice, exact cancellation boundary, and renewal
without a usage reset. RTL verifies all three access messages without ledger units.

References: [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
and [pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates).

### Plan-change review checkpoint (2026-09-12)

- [x] Review an existing paid plan separately from initial checkout. The billing
  page starts with the workspace's current billing interval.
- [x] Persist the selected target, current subscription/revision, exact upgrade
  proration timestamp and request parameters, Stripe preview, and expiry in
  migration `0096_workspace_plan_change_reviews.sql` (prepared, not deployed).
- [x] Use Stripe's returned upgrade amount. The preview requests immediate
  proration with an unchanged billing anchor; stored execution parameters require
  `pending_if_incomplete` so a future upgrade handler cannot grant unpaid capacity.
- [x] Review downgrades for the current subscription period's end, with zero due
  now and no immediate invoice preview. Keep the existing plan and usage untouched.
- [x] Retain the Team platform item once when adding/removing Team 20× capacity.
- [x] Reject wrong scope, cadence changes, quantities above one, existing schedules,
  pending updates, cancellation, failure, stale state, unapproved prices, and
  previews containing unrelated charges, non-proration lines, balances, or
  unsupported adjustments. No local arithmetic substitutes for Stripe amounts.
- [x] Show upgrade amount or downgrade date, retained weekly usage, and review
  expiry in the app. Discard stale workspace/session responses; allow explicit retry.
- [ ] Confirm a persisted review, create the immediate upgrade or renewal schedule,
  recover ambiguous Stripe responses, and reconcile paid/scheduled plan changes.
  Review responses report `changesEnabled: false`; the action stays disabled.
- [ ] Verify these requests against actual sandbox subscriptions. Tests mock Stripe
  HTTP, and the browser visual probe uses controlled preview responses.

The maintainer-only endpoint is
`POST /api/v2/orgs/:orgId/billing/change-rehearsal/review`. It uses the existing
loopback/test-key/local-flag/explicit-opt-in gate. It accepts only offer, billing
interval, and quantity one. It creates no charge, subscription update, schedule,
entitlement, or usage reset. Reviews expire after 15 minutes or at the current
billing boundary, whichever comes first. A concurrent lifecycle change prevents
review persistence. Existing billing and covered-access rules remain separate.

Validation: 118 targeted worker/migration tests, 127 real-Postgres tests, and
62 UI/impact/determinism tests pass. The three billing smoke journeys pass. A
separate temporary browser probe verifies the downgrade review on the real billing
page using preview fixtures; screenshot: `/private/tmp/aqu-837-downgrade-review.png`.
The probe contains no browser page errors and is removed after inspection; UI-only
coverage remains in RTL. Worker TypeScript and the production build pass.

Commands:

```sh
pnpm --dir auth-worker exec vitest run \
  src/__tests__/billing-workspace-change.test.ts \
  src/__tests__/billing-workspace-checkout.test.ts \
  src/__tests__/billing-workspace-migration.test.ts --maxWorkers=2
pnpm --dir auth-worker exec vitest run \
  --config vitest.webhook-postgres.config.ts
npx vitest run src/components/org/Billing*.test.tsx \
  src/pages/settings/OrgSettingsBilling.test.tsx \
  scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2
pnpm --dir auth-worker exec tsc --noEmit
npm run build
E2E_SHARD=3/3 npx tsx scripts/e2e-up.ts -- \
  e2e/specs/orgs/org-settings-billing.smoke.spec.ts --shard=1/1
```

Test-impact notes: the real checkout and signed activation producer feeds the
change-review service, route, and JSON persistence through the production Postgres
adapter. RTL drives the real API client into the review UI. The existing billing
smoke has explicit reset setup so Bob-only cases do not depend on the first test.
The affected-test map now includes lifecycle/change migrations and shared access
rules. Shared catalog fixture loading also works in Node and the browser-like test
environment. No release/deploy gate, live Stripe copy, or deployed change occurs.

Reference: [Stripe invoice previews](https://docs.stripe.com/api/invoices/create_preview)
and [payment-gated pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates).

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
- [x] Failed-payment access rule: **approved by Ryder, 2026-09-11**. Immediately
  fall back to Free. Existing weekly usage counts against Free's cap; usage at or
  above that cap leaves no remaining allowance. Confirmed recovery restores the
  paid cap without resetting usage.
- [x] Upgrade allowance rule: **approved by Ryder, 2026-09-11**. Immediate cap
  increase, with already-used weekly allowance unchanged.
- [x] Downgrade timing and allowance rule: **2026-09-12 preference; conditional
  on native Stripe support as of 2026-09-13 (see direction above)**.
  Take effect at the next billing cycle. Keep the current plan and cap until then.
  Preserve weekly consumption when the lower cap takes effect; do not reset the
  usage week at the billing boundary. This supersedes the 2026-09-11 immediate
  downgrade rule.
- [x] Cancellation access rule: **approved by Ryder, 2026-09-11**. Cancellation
  does not remove already-paid access. At the paid period's end, use Free's cap
  with the current week's usage retained.
- [x] Upgrade financial rule: **approved by Ryder, 2026-09-12**. Charge the
  prorated upgrade difference immediately. The increased cap preserves usage.
- [x] Downgrade billing rule: **2026-09-12 preference; conditional on native
  Stripe support as of 2026-09-13 (see direction above)**. Apply the lower
  plan at the next billing cycle, with the current paid period retained. No
  immediate downgrade or unused-time credit is required by this flow.
- [ ] Define downgrade membership handling and any cancellation refund policy;
  approval of access timing does not authorize refunds or membership removal.
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


### 2026-09-16 dev integration checkpoint

- [x] Resolve the eight conflicts from integrating `origin/dev` at
  `85e376fdfbb70901f6f11b8a3214636a277eb085` into the AQU-837 checkout.
  Preserve the import-classification checkpoint `c17a59d6b`, Stripe event
  coverage, billing schema, and dev's agent authorization and activity tables.
- [x] Preserve both billing and agent-connect E2E impact rules. Migration
  tracking uses complete filenames, so overlapping numeric prefixes do not
  require renaming already-applied migrations.
- [x] Restore `context_required` to the contextual route error-code type.
  Existing route tests exercise the exact missing-context response.
- [x] Update the shared history smoke helper for dev's **More actions**
  overflow. Existing concurrent-edit assertions still require convergence,
  preservation of both edits, and promotion of the bumped edit.
- [x] Pass the production build, worker TypeScript check, 42 billing UI/impact/
  determinism tests, 33 contextual-route tests, and tracked-file secret scan.
- [x] Run all 210 real-Postgres billing tests: 209 initially pass; the one
  failure mixes wall-clock Checkout activation with a recorded Stripe timeline.
  Fix the fixture clock and rerun all nine lifecycle tests successfully. The
  other 201 tests pass in the initial run.
- [ ] Resolve the session-expiry banner dismissal failure before release.
  The corrected smoke run passes 72 of 73 tests, including the
  collaboration/history journey, but exposes
  `session-expired-banner.smoke.spec.ts:121`: the banner remains visible after
  **Dismiss**. It passed in the first run. The signal can be raised by another
  rejected request after dismissal; the exact triggering request still needs
  investigation. No assertion is weakened, and the smoke gate is not green.

The initial full smoke run passed 72 of 73 tests. Its sole failure was the
obsolete direct edit-history selector, now corrected. No live Stripe action,
push, or deployment occurs in this integration checkpoint.

Verification commands for this checkpoint:

- `npm run build`
- `pnpm --dir auth-worker exec tsc --noEmit`
- `npx vitest run src/pages/settings/OrgSettingsBilling.test.tsx scripts/e2e-impact.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2`
- `pnpm --dir auth-worker exec vitest run src/__tests__/contextual-routes.test.ts --maxWorkers=1`
- `pnpm --dir auth-worker exec vitest run --config vitest.webhook-postgres.config.ts`
- `pnpm --dir auth-worker exec vitest run --config vitest.webhook-postgres.config.ts src/__tests__/billing-native-lifecycle.test.ts`
- `npm run test:e2e:smoke` (initial run and post-helper-fix run)
- `pnpm scan:secrets` and `git diff --cached --check`

Test impact: the production contracts remain unchanged. The Stripe fixture
producer and lifecycle/entitlement readers now share one deterministic test
clock. The shared browser page object follows the current action overflow,
while the existing collaboration journey still verifies Postgres-backed
history across two browser contexts. The contextual error-code union now
matches the response already asserted by the route integration tests.
