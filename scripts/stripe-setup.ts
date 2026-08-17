/**
 * Create (or reprint) the Aquilla Field Plan Stripe catalog in test mode.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts
 *
 * Prints product + price ids. Put the price ids in wrangler [vars]
 * (STRIPE_PRICE_FIELD / STRIPE_PRICE_ADDON). Never commit the secret.
 */

const SECRET = process.env.STRIPE_SECRET_KEY?.trim()
if (!SECRET) {
  console.error("Set STRIPE_SECRET_KEY")
  process.exit(1)
}

async function stripe(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params)
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(JSON.stringify(json))
  }
  return json
}

const field = await stripe("/products", {
  name: "Aquilla Field Plan",
  description: "Self-serve Field Plan: $500 / 4 weeks, includes 100,000 AI words.",
  "metadata[aquilla_plan]": "field",
})
const fieldPrice = await stripe("/prices", {
  product: String(field.id),
  currency: "usd",
  unit_amount: "50000",
  "recurring[interval]": "week",
  "recurring[interval_count]": "4",
  "metadata[aquilla_plan]": "field",
})
const addon = await stripe("/products", {
  name: "Aquilla word add-on",
  description: "100,000 additional AI words for the current Field Plan period.",
  "metadata[aquilla_plan]": "addon",
})
const addonPrice = await stripe("/prices", {
  product: String(addon.id),
  currency: "usd",
  unit_amount: "20000",
  "metadata[aquilla_plan]": "addon",
})

console.log("STRIPE_PRICE_FIELD=" + String(fieldPrice.id))
console.log("STRIPE_PRICE_ADDON=" + String(addonPrice.id))
