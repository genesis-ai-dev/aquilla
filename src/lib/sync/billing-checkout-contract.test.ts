import { describe, expect, it, vi, afterEach } from "vitest"
import { fieldPriceId } from "../../../auth-worker/src/lib/billing/field-pricing"
import { checkoutSchema } from "../../../auth-worker/src/lib/billing/checkout-input"
import { startBillingCheckout } from "./billing"

afterEach(() => vi.unstubAllGlobals())

describe("Field billing interval contract", () => {
  it.each(["monthly", "annual"] as const)("routes the real client %s selection to its configured price", async (interval) => {
    let selected: string | undefined
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = checkoutSchema.parse(JSON.parse(String(init.body)))
      selected = fieldPriceId({
        STRIPE_PRICE_FIELD_MONTHLY: "price_monthly_600",
        STRIPE_PRICE_FIELD_ANNUAL: "price_annual_6000",
      }, body.billingInterval)
      return Response.json({ url: "https://checkout.stripe.com/test" })
    })
    await startBillingCheckout("jwt", 1, "field", 1, interval)
    expect(selected).toBe(interval === "annual" ? "price_annual_6000" : "price_monthly_600")
  })

  it("never falls back to the old four-week price", () => {
    expect(() => fieldPriceId({})).toThrow("STRIPE_PRICE_FIELD_MONTHLY")
    expect(() => fieldPriceId({}, "annual")).toThrow("STRIPE_PRICE_FIELD_ANNUAL")
  })
})
