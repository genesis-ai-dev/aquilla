# Aquilla pricing model

Updated: 2026-09-16

This document defines Aquilla’s target pricing model for Stripe, in-app billing, sales, and aquilla-marketing. It supersedes earlier Field pricing descriptions for new implementation. It describes the intended offer, not current implementation status. Unresolved launch decisions appear at the end.

## Two audiences, one pricing page

The pricing page has **Individual** and **Team & Enterprise** tabs. Team & Enterprise is the default. Direct links preserve the selected audience. Individual contains Free, Pro, and Max. Team & Enterprise contains Team and Enterprise. **Team replaces the customer-facing name Field.** Enterprise leads to **Discuss your rollout**, using the existing rollout page.

## Plans and included AI capacity

All multipliers compare allowances over the same weekly usage period. **Max 5× and 20× always mean multiples of Pro, not Free.** Credits are an internal accounting unit only. Customers see relative AI capacity and percentage usage, never credit counts. Allowances do not guarantee a fixed number of translated words or completed jobs.

| Plan or capacity option | Internal weekly allowance (never customer-facing) | Offer and price |
| --- | ---: | --- |
| Free | 25 | Explore Aquilla. Free, no card required. |
| Pro | 50 | Regular individual use. 2× Free. $20 USD/month or $200/year. |
| Max 5× | 250 | Individual use with 5× Pro capacity. $60 USD/month or $600/year. |
| Max 20×, quantity N | 1,000 × N | Individual use with 20× Pro capacity per recurring block. $120 USD/month or $1,200/year per block. |
| Team, base capacity | 250 | Shared Max 5× capacity. $600 USD monthly or $6,000 USD annually, equivalent to $500/month. |
| Team, 20× capacity, quantity N | 1,000 × N | Shared capacity with Team capabilities. $600 + $120 × N USD/month, or $6,000 + $1,200 × N USD/year. |
| Enterprise | Agreed in contract | Custom annual quote covering platform usage, rollout, and support. |

The launch catalog fixes N to one. Higher quantities remain a future capability
and require an explicit supported checkout/portal contract. Selecting 20× capacity replaces the base allowance: one block totals 1,000 internal units per week, two total 2,000. It does not add the base 250 units. Capacity purchases do not add collaborators or permissions.

Usage resets weekly; monthly and annual billing remain unchanged. Each week's
internal allowance equals the previous monthly reference amount divided by four.
Use successive seven-day periods anchored to activation (workspace creation for
Free), with an exact reset timestamp shown in the app. This is a full reset, not
a rolling seven-day lookback. Billing renewals do not create an extra usage reset.
Unused allowance does not roll over. Annual payment does not grant an upfront pool.

Implementation interpretation: weeks continue across calendar-month boundaries;
there are about 52 weekly allocations per year, not 48. Monthly/4 sets weekly
capacity rather than a strict calendar-month cap. No five-hour throttle is enabled;
keep any future short-window throttle separate from the weekly entitlement.

## Internal provider-cost accounting

Ryder approves provider cost with one uniform multiplier across tools. Agent work
uses more allowance when it consumes more tokens; it receives no extra surcharge.
The initial version `2026-09-cost-v1` uses the existing base conversion: one
internal unit is one marked-up cent, at 4× raw provider cost. Preserve the approved
weekly counts. Pro's 50 units therefore cover 12.5 raw provider cents per week;
validate realistic workload capacity before enabling paid enforcement.

Decisions 2026-09-16 (Ryder):

- Rate card: OpenRouter's live per-model prices are the source of truth for the
  pre-call reservation bound. The server fetches and caches them; no repo-maintained
  price table. A model missing from the live card is refused, never estimated.
  Settlement always uses the provider-reported cost of the actual request.
- Markup: keep 4× and the approved allowance counts for launch. Customers see only
  percentage of the weekly allowance used and their plan. If measured margins are
  healthy, raise allowances later by an explicit policy version.
- Model choice: users cannot pick the model. Routing stays server-owned.
- Audio rails (TTS, diarization, voice conversion): not metered against the weekly
  allowance at launch. Revisit once usage patterns are visible.
- Agent overage: a run may finish its current step up to 5% over the weekly
  allowance; no new step starts past 100%. The customer-facing percentage caps
  at 100%; the ledger records the true overrun.
- Legacy ledgers: retire the credit and word guards once the weekly ledger covers
  every producer. The weekly ledger becomes the only usage authority.

Record raw cost and its rate version together. Do not retroactively reprice
consumed usage when configuration changes. Keep fractional usage internally,
reserve capacity before calls, and reconcile actual provider cost afterward.
Missing cost remains unresolved; it must not silently become free work. The
legacy word ledger is not the new weekly allowance authority.

## Customer-facing usage presentation

Approved direction: hide credits across the app and marketing site. Retain the
internal ledger and entitlement values for accounting, enforcement, and analysis.
This changes presentation, not the approved prices, allowances, or reset rules.

- Pricing cards and comparisons describe relative capacity: Pro has 2× Free;
  Max offers 5× or 20× Pro. Team base has 5× Pro capacity shared across the team;
  Team 20× has 20× Pro capacity per selected increment. Always name the baseline.
- Show higher selections as total relative capacity (for example, 40× Pro),
  rather than customer-facing credit counts or internal block accounting.
- App usage shows percentage used for the current workspace and allowance period,
  the reset date, and whether usage is personal or shared. Derive the percentage
  from the authoritative consumed usage and applicable allowance. Never fabricate
  a percentage for unavailable, undefined, or unmetered allowances.
- Hide credit counts and credit terminology in customer billing, usage panels,
  upgrade selectors, notifications, exhaustion errors, onboarding, FAQs, and
  marketing. Internal operator tools may retain the ledger and credit values.
- Keep usage rules visible: weekly resets with monthly or annual billing, no rollover,
  shared team allowance, exhaustion behavior, and supported capacity increases.
  Explain any additional operational limits separately; do not imply a single
  weekly meter guarantees every request is available.
- State that usage varies with the work performed. Avoid fixed word/book/job
  equivalents. Relative capacity must remain consistent with the actual plan
  allowance; presentation flexibility does not authorize silent entitlement changes.
- Test customer-visible copy and percentage calculations, including zero usage,
  exhaustion, reset boundaries, changed capacity, and unavailable usage data.

## Features, ownership, and upgrades

- **Free:** core editor, import/export, living memory, unlimited projects, and basic AI assistance within its weekly allowance.
- **Pro:** all Free capabilities plus advanced AI tools: the in-app agent, AI-assisted translation briefs, suggested checks based on edit patterns, and API tokens for connecting external agents. These are target entitlements, not claims that each feature already ships.
- **Max:** all Pro capabilities with more weekly AI capacity. Max does not introduce another feature gate or Team permissions.
- **Team:** inherits Pro AI tools within the owning team's shared allowance, alongside the collaboration capabilities below. Enterprise capabilities follow its agreed entitlement.
- **Individual collaboration:** proposed boundary is one primary operator and up to three active guest reviewers across the workspace. Final reviewer permissions require confirmation before launch. Buying more capacity never unlocks Team capabilities.
- **Team:** up to 20 collaborators, shared project ownership, team roles, advanced workflows, review queues, centralized billing, and onboarding/support as defined in the service offer. Verify availability and enforce permissions before advertising them.
- **Enterprise:** organization-wide adoption with agreed governance, training, rollout, support, and usage. Additional technical controls must be available or explicitly scoped in the quote.

The workspace owns the subscription and allowance. Individual allowances belong to a personal workspace; Team allowances form one shared team pool. Activity on an organization’s project consumes that organization’s allowance, even when the person has Pro or Max personally. Joining a team does not automatically transfer personal projects or cancel a personal subscription.

When AI capacity runs out, preserve access to existing work, manual editing, and export. Additional AI work requires renewal or an explicitly purchased capacity increase. Do not enable automatic charges or pay-as-you-go initially.

## Pro feature entitlements and app enforcement

Customer copy: **Advanced AI tools**. Explain this with concrete actions:
“Work with the AI agent, draft translation briefs, get suggested quality checks,
and connect your own agents.” Call the edit-pattern feature **Suggested checks**;
it proposes checks for review rather than silently changing translation rules.

The personal workspace allowance covers Aquilla-funded AI work on projects owned
by that workspace, across basic assistance and unlocked advanced AI tools. All
such features draw from one pool; Pro does not allocate separate pools per tool.
Existing work, manual editing, and export remain available after AI exhaustion.
External agents' own provider bills are not included. Calls through an API token
that invoke Aquilla-funded AI consume the target workspace's same pool.

Implement explicit capabilities for agent access, AI brief generation, suggested
checks, and external-agent API tokens. Resolve them from the owning workspace's
server-side entitlements, not the acting user's personal plan or a UI-only gate.
Enforce them for HTTP, streaming, queued/background, and external-agent entry
points. Tokens retain ordinary permission scopes and revocation; owning a token
never bypasses plan checks or usage enforcement. Preserve human authentication
and unrelated existing integrations when introducing the paid token capability.

The billing API must expose capability availability, weekly usage percentage,
and reset time without customer-facing ledger values. Update app controls,
upgrade prompts, usage/exhaustion messages, and marketing comparisons together.
Do not advertise unavailable features merely because an entitlement flag exists.
Verify actual availability of each feature before paid launch.

Regression coverage must prove Free denial, Pro/Max feature parity, team versus
personal ownership isolation, token scope/revocation, and shared consumption
across tools. Cover exact weekly reset boundaries, concurrent consumption, no
extra allocation at monthly/annual renewal, and preserved usage during upgrades.

## Stripe and in-app billing contract

**Stripe is authoritative for purchasable monetary amounts, currencies, and billing intervals.** This document defines packaging; application entitlements define capabilities and allowances. Never infer entitlements from a displayed amount or editable product name.

- Free has no paid subscription. Create paid catalog entries for Pro, Max, and Team. Max has 5× and 20× capacity variants; Team has base and 20× variants. At launch, use one subscription item with quantity one for each offer; higher capacity quantities remain unavailable.
- Team base requires USD Prices of $600/month and $6,000/year. Pro is $20/month or $200/year; Max 5× is $60/month or $600/year; Max 20× blocks are $120/month or $1,200/year. All prices are USD. Enterprise uses an agreed quote and provisioned entitlements, not public self-serve checkout.
- Maintain an explicit server-side mapping from approved Stripe Price IDs to plan, capacity, renewal interval, and allowed quantity. Reject quantity above one in the launch catalog. Any future multi-block support is limited to 20× variants and requires separate verification.
- Team 20× includes the Team platform charge once. The native launch catalog bundles the total into one Price: $720/month or $7,200/year. Historical two-item catalog records remain readable; they are not the launch checkout shape.
- In-app monetary amounts must come from Stripe through the authenticated billing API, including customer-specific subscription prices. Never display hard-coded or fallback prices. If Stripe pricing is unavailable, show plan and usage information without amounts and make purchase actions unavailable.
- In-app billing shows plan, allowance scope, percentage of allowance used, reset date, relative capacity, renewal date, and available billing actions. Annual amounts show both the full annual charge and its monthly equivalent.
- Checkout and billing changes use server-approved prices. Verified, idempotently processed Stripe events reconcile paid subscription state; a success redirect alone never grants access or credits.
- Stripe Customer Portal handles immediate price changes with prorations invoiced immediately. Upgrades raise the cap after verified payment; downgrades take effect immediately and can create account credit, without promising cash refunds. Cancellation retains already-paid access through period end. Failed payment immediately applies the Free cap. Every cap change preserves consumed weekly usage.
- Preserve existing subscriptions and negotiated access until an explicit migration is approved. Renaming Field does not authorize repricing or changing existing renewal schedules.

## Sales and marketing contract

Sell Free as exploration, Pro as advanced AI tools for individual translation work, and Max as everything in Pro with more weekly capacity. Sell Team as shared translation operations with pooled usage. Sell Enterprise as a scoped organization-wide rollout. Higher usage alone does not require Enterprise while supported capacity blocks meet the customer’s needs.

Update aquilla-marketing’s cards, comparisons, FAQs, links, and Field references together. Use **5× Pro** and **20× Pro**, and explicitly label Team usage as shared across the team. Keep billing-period and capacity selectors distinct. A translator landing page may explain the individual workflow and link to the Individual pricing tab.

Public monetary prices must match active Stripe Prices. Marketing may render a validated Stripe-derived snapshot; in-app surfaces require Stripe-sourced values. Do not independently maintain conflicting price constants. Show Team annual billing as **$500/month, $6,000 billed annually**.

Keep Enterprise’s custom quote and rollout action. Preserve the existing covered-access inquiry for qualifying organizations; this pricing model does not revoke sponsored or negotiated access. Do not advertise unimplemented features or unspecified support commitments.

## Decisions required before paid launch

1. Confirm maximum self-service 20× block quantity. Baseline prices and monthly/annual intervals are approved.
2. Confirm guest-reviewer actions and whether the Team collaborator limit includes its owner.
3. Specify Team versus Enterprise onboarding and support commitments.
4. Verify the approved native lifecycle policies across remaining real sandbox cases and finalize existing-customer migration.
5. Verify provider-cost metering and feature permissions across all producers and consumers. Allowance counts and 4× are approved for launch (2026-09-16); capacity is revisited from measured margins, not before launch.

Implement and test the complete pricing path: Stripe catalog → billing API → in-app/marketing display → checkout → webhook → workspace allowance and permissions. Include weekly resets independent of billing renewals, recurring quantities, personal/team isolation, and usage-preserving plan changes.


## Price experiments and retention (approved direction)

Start with the baseline above. The proposed higher individual ladder ($30/$80/
$160 monthly) is a future hypothesis, not an active experiment or approved live
catalog. Keep Team and Team capacity pricing unchanged in that first test.

Separate entitlement version, plan, capacity tier, price version, experiment,
and assigned variant. Multiple immutable Stripe Price IDs may map to identical
entitlements. Never update existing subscribers to a new experiment price.

Assign new eligible workspaces once on the server and persist the assignment.
Randomize by workspace, not page view, collaborator, device, or checkout attempt.
Keep the exposure cohort immutable while recording plan changes over time.
Purchases must use the assigned approved server catalog. Measure exposure only
when the offer is actually shown; fetching or assigning alone is not exposure.

Segment by workspace scope (personal/team), plan (free/pro/max/team/enterprise),
capacity tier, quantity, billing interval, acquisition price version, experiment
and variant, subscription status, sponsored/negotiated access, and paid cohort.
Record plan and price properties on each event so later upgrades do not rewrite
historical retention cohorts. Joining a team must not overwrite a person's
personal subscription identity.

Use verified server-side payment records for first/second/third paid renewals,
not checkout redirects or browser-only analytics. Distinguish renewal invoices
from prorations, quantity changes, duplicate deliveries, and $0 invoices. Annual
customers need monthly product-retention cohorts; do not compare their second
payment timing directly with monthly subscribers. Preserve existing analytics
consent and avoid sending translation text or organization names to analytics.

Track activated-workspace conversion, retained successful work, renewal
retention, allowance pressure, expansion, and contribution per activated signup.
No price experiment is enabled by this document.
