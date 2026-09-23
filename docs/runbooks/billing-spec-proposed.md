---
name: Billing and tiers
summary: Organization-owned Explore, Field, and Enterprise plans, shared AI limits, covered-access review, and gated Stripe checkout.
origin: codex
status: draft
last-updated: 2026-09-08
revisions:
  - 2026-09-08: AQU-1091 and AQU-837 reconcile pricing, covered access, and pre-launch billing behavior with the current auth-worker implementation. Production launch remains gated.
  - 2026-05-25: Initial future billing model; superseded by the organization-owned commercial model below.
---

# Billing and tiers

> Superseded draft. Do not apply this proposal. Use
> `docs/pricing/pricing-model.md` and `stripe-go-live.md` for the approved target.

## Commercial offer

- Explore is free. Projects and their AI allowance belong to the organization.
- Field costs USD $600 per calendar month or $6,000 per year. Annual pricing is
  displayed as $500/month with the full annual commitment beside it.
- Field includes up to 20 collaborators. This describes the commercial offer;
  enforcement of membership limits is a separate implementation concern.
- Enterprise uses a custom annual quote covering support and platform usage.
- ETEN affiliates and Bible-translation teams have a distinct contact path to
  confirm covered Field access before paying. Eligibility requires human review.

## Pricing and billing acceptance criteria

- The marketing pricing page defaults to annual billing and lets buyers select
  monthly billing. Both choices display a monthly equivalent and explicit terms.
- Organization settings show the current plan and an upgrade action without
  repeating legacy four-week prices or unavailable add-on purchases.
- Before launch, Field checkout reads Coming soon and remains disabled.
- Configuring Stripe credentials or prices must not enable checkout by itself.
  A separate server-side launch gate controls the billing snapshot and endpoint.
- Monthly and annual requests select distinct explicit Stripe price IDs. Neither
  falls back to a legacy four-week price.
- Covered Field organizations without a Stripe customer are not prompted to
  open a payment portal. Administrators can assign their plan without a payment.
- Existing Stripe-backed organizations retain customer portal access when
  configured. An offline plan override does not cancel an existing subscription.
- A checkout return URL alone is not proof of payment; the UI waits for the
  authoritative billing state before representing the plan as active.

## AI usage rules

- All collaborators share the owning organization's AI capacity across projects.
- Current cost accounting totals today and the preceding six UTC dates. It is
  a rolling seven-day window, not a fixed weekday reset or an exact 168-hour timer.
- Capacity returns as older daily usage buckets leave the window. Daily and
  agent-specific caps may apply in addition to the organization weekly cap.
- Monthly versus annual payment does not determine the AI accounting window.
- Enforcement depends on environment and per-organization configuration.
  Log-only settings must not be presented as enforced limits.
- When enforced, an exhausted AI limit rejects affected AI requests. It does
  not delete existing projects or revoke manual editing and review access.
- Plan assignment and cost-cap configuration are separate admin operations.
  The product must not promise a fixed multiplier without verified plan caps.
- The legacy word/Agent Credits ledger is separate from cost-based limits.
  Its historic 28-day accounting does not define the public weekly offer.

## Additional capacity and Enterprise

Self-service allowance purchases and automatic overage invoicing are unavailable.
Teams contact Aquilla to discuss additional requirements. Enterprise quotes and
changes are handled by the commercial team. The product does not promise
mid-year proration, allowance rollover, or automatic additional capacity.

## Launch boundary

The prepared changes are not a production launch. Before enabling checkout,
verify sandbox monthly/annual purchases, signed webhook reconciliation, failed
payments, cancellation, renewal, and portal behavior. Verify deployed AI caps
and covered-access organizations separately. Reconcile the legacy admin price
editor before using it to create future commercial prices.

## Implementation references

- App: `src/pages/settings/OrgSettingsBilling.tsx`
- Identity: `auth-worker/src/routes/billing.ts`
- AI limits: `auth-worker/src/lib/credits.ts`
- Admin overrides: `auth-worker/src/routes/admin-billing.ts`
- Operator playbook: `docs/runbooks/stripe-go-live.md`
- Marketing: `aquilla-marketing/public/mkt/pricing-v5.html`

This revision reconciles part of the spec/prototype divergence tracked by the
Linear project “Bring aquilla-specs into line with prototype divergence”.
