import process from "node:process"
import { pathToFileURL } from "node:url"

export async function provisionFieldCatalog(
  secret = process.env.STRIPE_SECRET_KEY?.trim(),
  existingProductId = process.env.STRIPE_FIELD_PRODUCT_ID?.trim(),
) {
/** Provision the current Field catalog in a Stripe sandbox; never enable checkout. */
if (!secret?.startsWith("sk_test_")) {
  throw new Error("Use a Stripe test secret. Live provisioning requires an operator.")
}

async function stripe(path: string, params?: Record<string, string>, key?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(`Stripe request failed (${response.status}); inspect the request in Stripe.`)
  return body
}

const productId = existingProductId || "aquilla_field_2026_09"
// A stable product ID and lookup keys prevent duplicate catalog entries on reruns.
const productResponse = await fetch(`https://api.stripe.com/v1/products/${productId}`, {
  headers: { Authorization: `Bearer ${secret}` },
})
if (productResponse.status === 404) {
  if (existingProductId) throw new Error("The supplied Field product does not exist in this Stripe account.")
  await stripe("/products", {
    id: productId,
    name: "Aquilla Field",
    description: "Ongoing team translation and review. Includes up to 20 collaborators and shared organization AI usage limits.",
    "metadata[aquilla_plan]": "field",
  }, "aquilla-field-product-2026-09")
} else if (!productResponse.ok) {
  throw new Error(`Cannot inspect Field product (${productResponse.status})`)
}

for (const [interval, amount, variable] of [
  ["month", "60000", "STRIPE_PRICE_FIELD_MONTHLY"],
  ["year", "600000", "STRIPE_PRICE_FIELD_ANNUAL"],
]) {
  const lookup = `aquilla_field_usd_${interval}_${amount}_2026_09`
  const result = await stripe(`/prices?lookup_keys[]=${encodeURIComponent(lookup)}&limit=1`)
  const existing = (result.data as Array<Record<string, unknown>>)[0]
  const price = existing ?? await stripe("/prices", {
    product: productId, currency: "usd", unit_amount: amount,
    "recurring[interval]": interval,
    lookup_key: lookup, "metadata[aquilla_plan]": "field",
  }, lookup)
  if (price.product !== productId || price.unit_amount !== Number(amount) || price.currency !== "usd" ||
      (price.recurring as { interval?: string; interval_count?: number })?.interval !== interval ||
      (price.recurring as { interval_count?: number })?.interval_count !== 1 || price.active !== true) {
    throw new Error(`Existing price does not match ${variable}; review it in Stripe.`)
  }
  console.log(`${variable}=${String(price.id)}`)
}
console.log("Checkout remains disabled. No subscriptions, add-ons, or charges created.")


}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("Legacy Field setup is retired. Use scripts/stripe-pricing-baseline.ts with the documented Team overrides.")
}
