// Thin Stripe REST client + webhook verify. No SDK — Workers-friendly fetch
// and @noble/hashes HMAC, same stack as password hashing.

import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import type { Env } from "../../types"
import { StripeConfigError } from "./field-pricing"
export { StripeConfigError, fieldPriceId } from "./field-pricing"

import { secureCompare } from "../../utils/secure-compare"

const STRIPE_API = "https://api.stripe.com/v1"
const SIGNATURE_TOLERANCE_SEC = 300

export function stripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

export function requireStripeSecret(env: Env): string {
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (!key) throw new StripeConfigError("STRIPE_SECRET_KEY is not configured")
  return key
}


export function checkoutEnabled(env: Env): boolean {
  return env.BILLING_CHECKOUT_ENABLED === "true" && stripeConfigured(env)
}

export function addonPriceId(env: Env): string {
  const id = env.STRIPE_PRICE_ADDON?.trim()
  if (!id) throw new StripeConfigError("STRIPE_PRICE_ADDON is not configured")
  return id
}

export async function stripeForm(
  env: Env,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number | undefined> = {},
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const secret = requireStripeSecret(env)
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    body.set(key, String(value))
  }
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(method === "POST" && idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : body,
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const err = json.error as { message?: string } | undefined
    throw new Error(err?.message ?? `Stripe ${method} ${path} failed: ${res.status}`)
  }
  return json
}

/**
 * Verify a `Stripe-Signature` header against the endpoint's webhook secret.
 *
 * OPS-12 (docs/OPSEC-REVIEW-2026-08-17.md) — the header carries ONE `t` and
 * one-or-more `v1` entries:
 *
 *     t=1699999999,v1=<sig under secret A>,v1=<sig under secret B>
 *
 * More than one appears exactly while a webhook secret is being rolled: Stripe
 * signs with both the old and the new secret until the old one is expired.
 * Parsing the header into an object keeps only the LAST `v1`, so an endpoint
 * still holding the old secret would reject every event for the whole rollover
 * window — fail-closed, but it means webhook delivery breaks during the one
 * operation we most want to be routine, and billing state silently drifts
 * behind Stripe's. Check every candidate instead.
 */
export function verifyStripeSignature(args: {
  payload: string
  header: string
  secret: string
  nowSec?: number
}): boolean {
  let timestamp: string | null = null
  const signatures: string[] = []
  for (const piece of args.header.split(",")) {
    const idx = piece.indexOf("=")
    if (idx < 0) continue
    const key = piece.slice(0, idx).trim()
    const value = piece.slice(idx + 1).trim()
    if (key === "t") timestamp ??= value
    else if (key === "v1") signatures.push(value)
  }
  if (!timestamp || signatures.length === 0) return false

  const ts = Number(timestamp)
  const now = args.nowSec ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_SEC) return false

  const expected = bytesToHex(hmac(sha256, utf8ToBytes(args.secret), utf8ToBytes(`${timestamp}.${args.payload}`)))
  // No early return: every candidate is compared, so the work does not depend
  // on which position matched.
  let matched = false
  for (const signature of signatures) {
    if (secureCompare(expected, signature)) matched = true
  }
  return matched
}

export interface StripeCheckoutSession {
  id: string
  url: string | null
  customer: string | null
  subscription: string | null
  mode: string
  metadata: Record<string, string>
}

export async function createCheckoutSession(
  env: Env,
  args: {
    customerId?: string
    customerEmail?: string
    priceId: string
    mode: "subscription" | "payment"
    quantity?: number
    successUrl: string
    cancelUrl: string
    metadata: Record<string, string>
  },
): Promise<StripeCheckoutSession> {
  const params: Record<string, string | number | undefined> = {
    mode: args.mode,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    "line_items[0][price]": args.priceId,
    "line_items[0][quantity]": args.quantity ?? 1,
    client_reference_id: args.metadata.orgId,
  }
  if (args.customerId) params.customer = args.customerId
  else if (args.customerEmail) params.customer_email = args.customerEmail
  for (const [key, value] of Object.entries(args.metadata)) {
    params[`metadata[${key}]`] = value
  }
  if (args.mode === "subscription") {
    params["subscription_data[metadata][orgId]"] = args.metadata.orgId
    params["subscription_data[metadata][kind]"] = args.metadata.kind ?? "field"
  }
  const json = await stripeForm(env, "POST", "/checkout/sessions", params)
  return {
    id: String(json.id),
    url: typeof json.url === "string" ? json.url : null,
    customer: typeof json.customer === "string" ? json.customer : null,
    subscription: typeof json.subscription === "string" ? json.subscription : null,
    mode: String(json.mode ?? args.mode),
    metadata: (json.metadata as Record<string, string>) ?? args.metadata,
  }
}

export async function createPortalSession(
  env: Env,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const json = await stripeForm(env, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  })
  if (typeof json.url !== "string") throw new Error("Stripe portal session missing url")
  return { url: json.url }
}

export async function retrievePrice(
  env: Env,
  priceId: string,
): Promise<{ id: string; product: string; unitAmount: number | null; type: string }> {
  const json = await stripeForm(env, "GET", `/prices/${encodeURIComponent(priceId)}`)
  return {
    id: String(json.id),
    product: String(json.product),
    unitAmount: typeof json.unit_amount === "number" ? json.unit_amount : Number(json.unit_amount) || null,
    type: String(json.type ?? ""),
  }
}

export async function createCatalogPrice(
  env: Env,
  args: { productId: string; unitAmountCents: number; recurring: boolean },
): Promise<string> {
  const params: Record<string, string | number | undefined> = {
    product: args.productId,
    currency: "usd",
    unit_amount: args.unitAmountCents,
  }
  if (args.recurring) {
    params["recurring[interval]"] = "week"
    params["recurring[interval_count]"] = 4
  }
  const json = await stripeForm(env, "POST", "/prices", params)
  return String(json.id)
}

export async function retrieveSubscription(
  env: Env,
  subscriptionId: string,
): Promise<{
  id: string
  customer: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
}> {
  const json = await stripeForm(env, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`)
  const item = (json.items as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0]
  const start = Number(json.current_period_start ?? item?.current_period_start)
  const end = Number(json.current_period_end ?? item?.current_period_end)
  return {
    id: String(json.id),
    customer: String(json.customer),
    status: String(json.status),
    currentPeriodStart: Number.isFinite(start) ? new Date(start * 1000).toISOString() : new Date().toISOString(),
    currentPeriodEnd: Number.isFinite(end) ? new Date(end * 1000).toISOString() : new Date().toISOString(),
  }
}
