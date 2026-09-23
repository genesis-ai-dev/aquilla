export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StripeConfigError"
  }
}

export type FieldBillingInterval = "monthly" | "annual"

export function fieldPriceId(env: { STRIPE_PRICE_FIELD_MONTHLY?: string; STRIPE_PRICE_FIELD_ANNUAL?: string }, interval: FieldBillingInterval = "monthly"): string {
  const key = interval === "annual" ? "STRIPE_PRICE_FIELD_ANNUAL" : "STRIPE_PRICE_FIELD_MONTHLY"
  const id = env[key]?.trim()
  if (!id) throw new StripeConfigError(`${key} is not configured`)
  return id
}

