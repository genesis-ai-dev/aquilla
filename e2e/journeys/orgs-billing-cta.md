# See the current plan and the plan offers on org billing settings

Smoke twin: `e2e/specs/orgs/org-settings-billing.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- Dev Org is org id 1.

## Steps

1. Open `/orgs/1/settings`. A level-1 heading reads **Organization settings**.
2. Click the **Billing** link.
3. The URL becomes `/orgs/1/settings/billing` and a level-1 heading reads **Billing**.
4. Under **Plan**, the **Current plan** row shows a badge reading **Free**, **Team** or **Enterprise**.
5. Look for the **AI usage** panel.
6. Unless the badge reads **Team**, look for the **Compare new plans** group: a **Free** row, then either the **Team** row with its **Review Team** button or the notice **Plan prices are temporarily unavailable**, then the **Enterprise** row with the **Discuss your rollout** link.

## Expected end state

- The URL after step 2 is `/orgs/1/settings/billing`.
- The page shows the Current plan badge (one of Free, Team, Enterprise), the AI usage panel and, for a Free or Enterprise workspace, the Compare new plans group with the Discuss your rollout link. This journey does not complete a Stripe checkout; it only confirms the plan, the offers and the usage panel render.

## Counts as a failure

- **Billing** is missing from Organization settings, or clicking it does not navigate.
- The Current plan badge or the AI usage panel is missing, or the badge reads anything other than Free, Team or Enterprise (**Field Plan** was retired by AQU-2059 on 2026-10-21; seeing it is a regression).
- On a Free or Enterprise workspace, **Compare new plans** or **Discuss your rollout** never appears, or neither the Team row nor the prices-unavailable notice does.

## Notes for the agent

- The badge and the usage panel carry `data-testid="billing-plan"` and `data-testid="billing-usage"`; a CSS selector is more reliable here than the visible label, since the panel's own heading text can vary.
- The offers are plain text and a link, so an interactive snapshot never lists them; read the page text.
- Whether the Team row or the prices-unavailable notice shows depends on the target having Stripe prices configured, not on the app; either is a pass.
- Until 2026-10-21 this story looked for the text **Field Plan** (the old subscribe CTA). AQU-2059 replaced that plan with Free / Team / Enterprise, and the replay failed on every PR until it was refreshed on 2026-11-02.
