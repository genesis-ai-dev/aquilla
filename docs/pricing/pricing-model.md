# Aquilla pricing model

Updated: 2026-09-09

This document defines Aquilla’s target pricing model for Stripe, in-app billing, sales, and aquilla-marketing. It supersedes earlier Field pricing descriptions for new implementation. It describes the intended offer, not current implementation status. Unresolved launch decisions appear at the end.

## Two audiences, one pricing page

The pricing page has **Individual** and **Team & Enterprise** tabs. Team & Enterprise is the default. Direct links preserve the selected audience. Individual contains Free, Pro, and Max. Team & Enterprise contains Team and Enterprise. **Team replaces the customer-facing name Field.** Enterprise leads to **Discuss your rollout**, using the existing rollout page.

## Plans and included AI capacity

All multipliers compare allowances over the same monthly usage period. **Max 5× and 20× always mean multiples of Pro, not Free.** Credits measure AI allowance; they do not guarantee a fixed number of translated words or completed jobs.

| Plan or capacity option | Included credits per month | Offer and price |
| --- | ---: | --- |
| Free | 100 | Explore Aquilla. Free, no card required. |
| Pro | 200 | Regular individual use. 2× Free. $20 USD/month or $200/year. |
| Max 5× | 1,000 | Individual use with 5× Pro capacity. $60 USD/month or $600/year. |
| Max 20×, quantity N | 4,000 × N | Individual use with 20× Pro capacity per recurring block. $120 USD/month or $1,200/year per block. |
| Team, base capacity | 1,000 | Shared Max 5× capacity. $600 USD monthly or $6,000 USD annually, equivalent to $500/month. |
| Team, 20× capacity, quantity N | 4,000 × N | Shared capacity with Team capabilities. $600 + $120 × N USD/month, or $6,000 + $1,200 × N USD/year. |
| Enterprise | Agreed in contract | Custom annual quote covering platform usage, rollout, and support. |

N is a positive integer. Selecting 20× capacity replaces the base allowance: one block totals 4,000 credits, two total 8,000. It does not add the base 1,000 credits. Capacity purchases do not add collaborators or permissions.

Usage renews monthly on the subscription’s monthly anniversary, including annual subscriptions; use the last valid day in shorter months. Free receives a monthly anniversary at workspace creation. Included credits do not roll over. Annual payment buys twelve monthly allowances, not an immediately available annual pool. Replace the legacy 28-day/13-cycle model for new offers.

## Features, ownership, and upgrades

- **Free, Pro, and Max:** retain the core editor, import/export, living memory, and basic AI assistance. Keep unlimited projects. Pro and Max primarily increase AI capacity.
- **Individual collaboration:** proposed boundary is one primary operator and up to three active guest reviewers across the workspace. Final reviewer permissions require confirmation before launch. Buying more capacity never unlocks Team capabilities.
- **Team:** up to 20 collaborators, shared project ownership, team roles, advanced workflows, review queues, centralized billing, and onboarding/support as defined in the service offer. Verify availability and enforce permissions before advertising them.
- **Enterprise:** organization-wide adoption with agreed governance, training, rollout, support, and usage. Additional technical controls must be available or explicitly scoped in the quote.

The workspace owns the subscription and allowance. Individual allowances belong to a personal workspace; Team allowances form one shared team pool. Activity on an organization’s project consumes that organization’s allowance, even when the person has Pro or Max personally. Joining a team does not automatically transfer personal projects or cancel a personal subscription.

When AI capacity runs out, preserve access to existing work, manual editing, and export. Additional AI work requires renewal or an explicitly purchased capacity increase. Do not enable automatic charges or pay-as-you-go initially.

## Stripe and in-app billing contract

**Stripe is authoritative for purchasable monetary amounts, currencies, and billing intervals.** This document defines packaging; application entitlements define capabilities and allowances. Never infer entitlements from a displayed amount or editable product name.

- Free has no paid subscription. Create paid catalog entries for Pro, Max, and Team. Max has 5× and 20× capacity variants; Team has base and 20× variants. Use recurring quantity for 20× blocks within one workspace subscription.
- Team base requires USD Prices of $600/month and $6,000/year. Pro is $20/month or $200/year; Max 5× is $60/month or $600/year; Max 20× blocks are $120/month or $1,200/year. All prices are USD. Enterprise uses an agreed quote and provisioned entitlements, not public self-serve checkout.
- Maintain an explicit server-side mapping from approved Stripe Price IDs to plan, capacity, renewal interval, and allowed quantity. Permit quantity above one only for 20× variants. Reject unsupported combinations.
- Team 20× pricing must include the Team platform charge once. Use the Team platform price at quantity one plus the recurring 20× capacity price at quantity N; do not multiply the Team platform charge by block quantity accidentally.
- In-app monetary amounts must come from Stripe through the authenticated billing API, including customer-specific subscription prices. Never display hard-coded or fallback prices. If Stripe pricing is unavailable, show plan and usage information without amounts and make purchase actions unavailable.
- In-app billing shows plan, allowance scope, credits used/remaining, reset date, capacity quantity, renewal date, and available billing actions. Annual amounts show both the full annual charge and its monthly equivalent.
- Checkout and billing changes use server-approved prices. Verified, idempotently processed Stripe events reconcile paid subscription state; a success redirect alone never grants access or credits.
- Define proration, credit allocation during upgrades, payment-failure grace, cancellation, and downgrade behavior before checkout launches. Capacity changes must not reset consumed usage or grant duplicate allowances.
- Preserve existing subscriptions and negotiated access until an explicit migration is approved. Renaming Field does not authorize repricing or changing existing renewal schedules.

## Sales and marketing contract

Sell Free as exploration, Pro as regular individual use, and Max as more individual capacity. Sell Team as shared translation operations with pooled usage. Sell Enterprise as a scoped organization-wide rollout. Higher usage alone does not require Enterprise while supported capacity blocks meet the customer’s needs.

Update aquilla-marketing’s cards, comparisons, FAQs, links, and Field references together. Use **5× Pro** and **20× Pro**, and explicitly label Team usage as shared across the team. Keep billing-period and capacity selectors distinct. A translator landing page may explain the individual workflow and link to the Individual pricing tab.

Public monetary prices must match active Stripe Prices. Marketing may render a validated Stripe-derived snapshot; in-app surfaces require Stripe-sourced values. Do not independently maintain conflicting price constants. Show Team annual billing as **$500/month, $6,000 billed annually**.

Keep Enterprise’s custom quote and rollout action. Preserve the existing covered-access inquiry for qualifying organizations; this pricing model does not revoke sponsored or negotiated access. Do not advertise unimplemented features or unspecified support commitments.

## Decisions required before paid launch

1. Confirm maximum self-service 20× block quantity. Baseline prices and monthly/annual intervals are approved.
2. Confirm guest-reviewer actions and whether the Team collaborator limit includes its owner.
3. Specify Team versus Enterprise onboarding and support commitments.
4. Finalize upgrade/proration, downgrade, cancellation, payment-failure, and existing-customer migration policies.
5. Verify that credit metering and all feature permissions enforce this offer across producers and consumers.

Implement and test the complete pricing path: Stripe catalog → billing API → in-app/marketing display → checkout → webhook → workspace allowance and permissions. Include annual monthly resets, recurring quantities, personal/team isolation, and usage-preserving plan changes.


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
