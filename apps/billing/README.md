# @aquilla/billing

Billing UI app. Mounted at `/billing/*`.

Per 04-features/billing-and-tiers.md the full billing surface is `later`
(out of v1 scope). Phase 3c ships a "Coming Soon" scaffold so the
apps/<slug>/ topology is uniform and the route is reserved.

Future routes:
- `/`         — current plan + usage summary
- `/upgrade`  — Stripe Checkout handoff
- `/history`  — past invoices

The Stripe webhook receiver lives server-side (likely in
`apps/frontier-server/` or a dedicated `apps/billing-server/`) and is not
served from this app.

## Dev

```bash
pnpm --filter @aquilla/billing dev
pnpm --filter @aquilla/billing build
pnpm --filter @aquilla/billing test
```
