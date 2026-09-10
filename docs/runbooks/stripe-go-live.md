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
The primary slice owns explicit workspace billing scope, eligibility, initial
paid entitlement storage, and the workspace summary in billing settings.
It adds `billing-workspace.ts` routes and `workspace*.ts` billing services;
it does not change webhook receipt/application or `billing.ts`.
Migration `0092_workspace_billing.sql` is reserved for this slice.

The parallel agent owns webhook retry recovery in a separate worktree. Its
handoff belongs in `docs/runbooks/aqu-837-webhook-recovery-handoff.md`.
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
- [ ] Complete Stripe business/payout activation; create and verify live prices,
  the production webhook, live secrets, and customer portal configuration.
- [ ] Connect plan/cohort properties to billing and product activity for retention.
  Apply the cohort migration if used; keep price experiments off at launch.
- [ ] Commit/review the release, pass build and full smoke checks, and deploy
  app/API/marketing with paid checkout disabled. Preserve existing subscriptions.
- [ ] Verify production configuration, enable paid checkout, and confirm the first
  authorized purchase grants the right access. Monitor webhook/payment failures;
  disable new checkout if the payment-to-access path fails.

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
- [ ] Verify personal versus team workspace eligibility and server-side billing
  authority. Test another workspace's ID and a member without billing authority.
- [ ] Show the current plan, capacity, usage, reset date, renewal date, and
  eligible portal actions in billing settings.

### Workspace → approved Stripe Checkout

- [x] Prepare the approved ten-price sandbox manifest and offer composition.
  Evidence: `config/pricing/stripe-sandbox.json` and prior contract checks below.
- [ ] Retrieve and validate Stripe Prices through the billing API. Hide amounts
  and purchase actions when Stripe pricing cannot be verified.
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
- [ ] Make event application and deduplication recoverable together. Test a
  failure after receipt recording, then redelivery of the same Stripe event.
- [ ] Test duplicate and out-of-order events, simultaneous delivery, and an
  invoice arriving before subscription-to-workspace mapping exists.
- [ ] Reconcile paid renewal, failed payment, recovery, cancellation, upgrade,
  and downgrade according to the approved rules.
- [ ] Preserve legacy and covered access through subscription updates and replay.
  Reject events whose subscription/customer mapping conflicts with the workspace.

Inspection identifies a retry risk: the current handler records an event before
applying its subscription update. A later failure can leave redelivery classified
as a duplicate. Verify and fix this boundary before checking off event recovery.

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
- Account activation is 10% complete. Business type currently displays
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
