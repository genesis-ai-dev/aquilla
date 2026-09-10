import { z } from 'zod'
import type { AquillaDb } from '../../../../db/shim/postgres'
import type { Env } from '../../types'
import { paidOffers } from './catalog-view'
import { readValidatedBillingCatalog } from './catalog'
import { readBillingWorkspace } from './workspace'
import { quoteOffer } from './pricing-model'
import { stripeForm } from './stripe'

export const workspaceCheckoutInput = z.object({
  offer: z.enum(paidOffers), interval: z.enum(['month', 'year']), quantity: z.literal(1),
  // Compare with the server quote; these values never determine the charge.
  confirmedPriceVersion: z.string().min(1),
  confirmedTotalAmount: z.number().int().nonnegative(),
  confirmedCurrency: z.literal('usd'),
}).strict()
export class WorkspaceCheckoutConflict extends Error {}
interface Attempt {
  id: string
  account_id: string
  fingerprint: string
  request_params: Record<string, string | number>
  expires_at: number
  session_id: string | null
}
function readAttempt(db: AquillaDb, orgId: number) {
  return db.prepare(`SELECT id, account_id, fingerprint, request_params,
    expires_at, session_id FROM workspace_checkout_attempts WHERE org_id = ?`)
    .bind(orgId).first<Attempt>()
}
export function workspaceCheckoutRehearsalEnabled(env: Env, requestUrl: string) {
  return env.BILLING_WORKSPACE_CHECKOUT_REHEARSAL === 'true'
    && env.WRANGLER_LOCAL === '1'
    && /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY?.trim() ?? '')
    && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(requestUrl).hostname)
}
/** Rehearsal only. No payment/entitlement mutation and no production entry point. */
export async function startWorkspaceCheckoutRehearsal(
  env: Env, orgId: number, email: string | null | undefined,
  rawInput: unknown, requestUrl: string, now = new Date(),
) {
  if (!workspaceCheckoutRehearsalEnabled(env, requestUrl)) throw new Error('Checkout disabled')
  const input = workspaceCheckoutInput.parse(rawInput)
  const db = env.AQUILLA_PG
  if (!db.transaction) throw new Error('Checkout requires transactions')
  // Avoid external reads for workspaces that cannot purchase.
  const initial = await readBillingWorkspace(db, orgId, now)
  if (!initial || !initial.eligibility.offers.includes(input.offer)) {
    throw new WorkspaceCheckoutConflict('Workspace is not eligible for this plan')
  }
  const { catalog, prices } = await readValidatedBillingCatalog(env)
  const quote = quoteOffer(catalog, prices, input.offer, input.interval, input.quantity)
  if (quote.priceVersion !== input.confirmedPriceVersion
    || quote.totalAmount !== input.confirmedTotalAmount || quote.currency !== input.confirmedCurrency) {
    throw new WorkspaceCheckoutConflict('Prices changed. Review the plan again')
  }
  const fingerprint = JSON.stringify([quote.offer, quote.interval, quote.quantity,
    quote.currency, quote.totalAmount, quote.priceVersion, quote.entitlementVersion,
    quote.lineItems.map(line => [line.price, line.quantity])])
  const nowSec = Math.floor(now.getTime() / 1000)
  // Commit the immutable request before contacting Stripe. External calls never
  // hold the workspace lock. Retries use the same persisted parameters and key.
  const attempt = await db.transaction(async tx => {
    await tx.prepare('SELECT id FROM organizations WHERE id = ? FOR UPDATE').bind(orgId).first()
    const workspace = await readBillingWorkspace(tx, orgId, now)
    if (!workspace || !workspace.eligibility.offers.includes(input.offer)) {
      throw new WorkspaceCheckoutConflict('Workspace eligibility changed. Review the plan again')
    }
    const otherCohort = await tx.prepare(`SELECT price_version FROM billing_price_cohorts
      WHERE org_id = ? AND price_version <> ? LIMIT 1`).bind(orgId, quote.priceVersion).first()
    if (otherCohort) throw new WorkspaceCheckoutConflict('Existing pricing assignment requires review')
    const existing = await readAttempt(tx, orgId)
    if (existing) {
      if (existing.account_id !== catalog.accountId || existing.fingerprint !== fingerprint) {
        throw new WorkspaceCheckoutConflict('An unresolved checkout already exists. Reconcile it before changing plans')
      }
      return existing
    }
    const id = crypto.randomUUID()
    const expiresAt = nowSec + 23 * 60 * 60
    // Rehearsal returns only to this local origin, never a browser-provided URL.
    const returnTarget = new URL(env.BASE_URL ?? '')
    if (!['http:', 'https:'].includes(returnTarget.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(returnTarget.hostname)
      || returnTarget.username || returnTarget.password) throw new Error('Rehearsal requires a local app return origin')
    const origin = returnTarget.origin
    const metadata = { orgId: String(orgId), kind: 'workspace_plan_rehearsal',
      checkoutAttemptId: id, offer: quote.offer, billingInterval: quote.interval,
      priceVersion: quote.priceVersion, entitlementVersion: quote.entitlementVersion }
    const params: Record<string, string | number> = {
      mode: 'subscription', client_reference_id: String(orgId),
      success_url: `${origin}/orgs/${orgId}/settings/billing?checkout=rehearsal`,
      cancel_url: `${origin}/orgs/${orgId}/settings/billing?checkout=cancel`,
      expires_at: expiresAt,
    }
    if (email) params.customer_email = email
    quote.lineItems.forEach((line, index) => {
      params[`line_items[${index}][price]`] = line.price
      params[`line_items[${index}][quantity]`] = line.quantity
    })
    for (const [key, value] of Object.entries(metadata)) {
      params[`metadata[${key}]`] = value
      params[`subscription_data[metadata][${key}]`] = value
    }
    // Bind serialized JSON as text first: postgres.js otherwise encodes it twice.
    await tx.prepare(`INSERT INTO workspace_checkout_attempts
      (id, org_id, account_id, fingerprint, catalog_json, prices_json, quote_json,
       request_params, expires_at) VALUES (?, ?, ?, ?, ?::text::jsonb, ?::text::jsonb, ?::text::jsonb, ?::text::jsonb, ?)`)
      .bind(id, orgId, catalog.accountId, fingerprint, JSON.stringify(catalog),
        JSON.stringify(prices), JSON.stringify(quote), JSON.stringify(params), expiresAt).run()
    const saved = await readAttempt(tx, orgId)
    if (!saved) throw new Error('Checkout request was not persisted')
    return saved
  })
  // Never recreate with an old key after Stripe's retention boundary. Do not
  // rotate a key or delete an unresolved attempt after an ambiguous response.
  if (nowSec >= attempt.expires_at - 1800) {
    throw new WorkspaceCheckoutConflict('Checkout attempt requires reconciliation before retrying')
  }
  const session = attempt.session_id
    ? await stripeForm(env, 'GET', `/checkout/sessions/${encodeURIComponent(attempt.session_id)}`)
    : await stripeForm(env, 'POST', '/checkout/sessions', attempt.request_params,
      `aquilla-workspace-${attempt.id}`)
  if (typeof session.id !== 'string' || !/^cs_test_[a-zA-Z0-9_]+$/.test(session.id)
    || session.livemode !== false || session.mode !== 'subscription'
    || session.client_reference_id !== String(orgId)
    || (session.metadata as Record<string, unknown> | undefined)?.checkoutAttemptId !== attempt.id
    || (attempt.session_id !== null && session.id !== attempt.session_id)) {
    throw new Error('Checkout session does not match the request')
  }
  if (session.status !== 'open') throw new WorkspaceCheckoutConflict('Checkout is no longer open. Reconcile its outcome')
  const url = typeof session.url === 'string' ? new URL(session.url) : null
  if (!url || url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com'
    || url.username || url.password || url.port) throw new Error('Invalid checkout URL')
  const saved = await db.prepare(`UPDATE workspace_checkout_attempts SET session_id = ?
    WHERE id = ? AND (session_id IS NULL OR session_id = ?) RETURNING id`)
    .bind(session.id, attempt.id, session.id).first()
  if (!saved) throw new Error('Checkout session could not be persisted')
  return { attemptId: attempt.id, sessionId: session.id, url: url.toString(), sandbox: true }
}
