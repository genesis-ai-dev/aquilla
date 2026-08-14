# Stripe Field Plan + word-metered AI credits

**Date:** 2026-08-13 · **Status:** Implemented (self-serve Field Plan; Enterprise hard cap only)

## Goal

Org maintainers can subscribe to the Field Plan in Stripe, see AI word usage
for the current 4-week period, and buy 100,000-word add-on packs. Enterprise
pricing stays offline; Enterprise orgs only get a hard usage cap.

## Pricing (from the live Field Plan sheet)

- **Field Plan:** $500 / 4 weeks, includes 100,000 AI words.
- **Add-on:** $200 per extra 100,000 words in the same period.
- **Talk to us:** past 25 million words/year, self-serve add-ons stop.
- **Enterprise:** no self-serve checkout; `hard_cap_words` blocks AI at the cap.

## Rules

- Unpaid orgs keep working. Words are recorded; paid caps are not enforced.
- Paid Field / Enterprise orgs get a 429 `word_allowance_exceeded` on chat,
  agent, import, and contextual runs when the period allowance / hard cap is hit.
- Existing dollar credit ledger (`org_credit_usage_daily`) is unchanged.
- Stripe secret stays in `.dev.vars` / `wrangler secret put`. Never commit it.

## Surfaces

- `GET/POST /api/v2/orgs/:orgId/billing` (+ `/checkout`, `/portal`)
- `POST /api/v2/billing/webhook` (Stripe-Signature)
- Org settings → Billing & usage
- Org overview → AI words panel (maintainer+)
- Admin → Platform → Billing: catalog amounts, complimentary word/credit
  grants, usage resets, plan/hard-cap assignment. Dollar amount changes
  create a new Stripe Price when Stripe is configured; existing
  subscribers keep their current price. Grants and resets never touch Stripe.
