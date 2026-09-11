# See the Field Plan subscribe CTA on org billing settings

Smoke twin: `e2e/specs/orgs/org-settings-billing.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- Dev Org is org id 9.

## Steps

1. Open `/orgs/9/settings`. A level-1 heading reads **Organization settings**.
2. Click the **Billing & usage** link.
3. The URL becomes `/orgs/9/settings/billing` and a level-1 heading reads **Billing & usage**.
4. Look for a plan panel and a usage panel on the page, and the text **Field Plan** somewhere on it.

## Expected end state

- The URL after step 2 is `/orgs/9/settings/billing`.
- The page shows a plan panel, a usage panel, and the text **Field Plan** (the CTA to subscribe). This journey does not complete a Stripe checkout; it only confirms the CTA and usage numbers render.

## Counts as a failure

- **Billing & usage** is missing from Organization settings, or clicking it does not navigate.
- The plan panel or usage panel is missing.
- **Field Plan** never appears on the page.

## Notes for the agent

- The plan and usage panels carry `data-testid="billing-plan"` and `data-testid="billing-usage"`; a CSS selector (`[data-testid="billing-plan"]`) is more reliable here than trying to name them by visible label, since the panel's own heading text can vary.
