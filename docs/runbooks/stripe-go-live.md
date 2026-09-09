# Stripe launch and covered-access playbook

Updated: 2026-09-09. Tickets: AQU-837 (billing readiness), AQU-1091 (pricing and app UI).

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
  monthly credit resets, usage enforcement, and covered access.
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

These are implementation tasks, not just Stripe dashboard settings. The prepared
Field page and checkout remain an older draft until these steps are complete.

1. **Marketing → selected offer.** Replace Field with Team and add the Individual
   and Team & Enterprise tabs, defaulting to Team & Enterprise. Support deep links,
   monthly/annual selection, and approved block quantities. Show monthly equivalents
   and annual totals from a validated Stripe catalog. Explain monthly credit resets,
   exhaustion, cancellation, and additional capacity. Keep Enterprise and ETEN /
   Bible-translation inquiry paths; never imply affiliation automatically grants access.
2. **Selected offer → correct workspace.** Carry offer and interval through sign-in,
   then confirm the personal or team workspace being upgraded. Check billing authority
   on the server. Organization-owned projects consume that organization's allowance;
   a member's personal subscription must not pay for them. Billing settings show the
   current plan, allowance, renewal date, upgrade options, and eligible portal access.
3. **Workspace → Stripe Checkout.** Resolve approved Price IDs on the server, validate
   quantity and workspace eligibility, and retain the assigned pricing cohort. Team
   20× sends one platform item plus N capacity items. Never accept client-supplied
   amounts or grant access merely because the browser reaches the success page.
4. **Signed payment events → access.** Verify webhook signatures and apply events
   idempotently to the correct workspace. Persist subscription, price/entitlement
   versions, capacity, and the original monthly allowance anchor. Reconcile renewal,
   failure, cancellation, upgrades, and downgrades under the approved launch rules.
   Preserve legacy subscriptions and negotiated or sponsored access.
5. **Access → usable allowance.** Allocate and consume monthly credits safely across
   concurrent requests. Annual billing still resets credits monthly. Enforce personal
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

## Baseline catalog and experiment readiness — 2026-09-09

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
below. Team replaces the customer-facing Field name. New offers use monthly
anniversary credit periods, including annual subscriptions. Existing Field
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
