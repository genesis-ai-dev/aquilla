import { z } from 'zod'
import type { Env } from '../../types'
import { stripeForm } from './stripe'
import { readWorkspaceEntitlement } from './workspace'
import { workspaceCheckoutRehearsalEnabled, WorkspaceCheckoutConflict } from './workspace-checkout'

const configurationSchema = z.object({
  id: z.string(), active: z.literal(true), livemode: z.literal(false),
  features: z.object({
    invoice_history: z.object({ enabled: z.literal(true) }),
    payment_method_update: z.object({ enabled: z.literal(true) }),
    // Enable these only after portal-driven lifecycle changes are verified.
    subscription_update: z.object({ enabled: z.literal(false) }),
    subscription_cancel: z.object({ enabled: z.literal(false) }),
  }),
})

/** Hosted invoices/payment methods first; no custom billing calculation or writes. */
export async function startWorkspacePortalRehearsal(
  env: Env, orgId: number, requestUrl: string,
) {
  if (!workspaceCheckoutRehearsalEnabled(env, requestUrl)) throw new Error('Portal disabled')
  const stored = await readWorkspaceEntitlement(env.AQUILLA_PG, orgId)
  if (!stored) throw new WorkspaceCheckoutConflict('No workspace subscription to manage')
  const configuration = stored.scope === 'personal'
    ? env.STRIPE_PORTAL_PERSONAL_CONFIGURATION : env.STRIPE_PORTAL_TEAM_CONFIGURATION
  if (!/^bpc_[a-zA-Z0-9]+$/.test(configuration ?? '')) throw new Error('Portal configuration missing')
  const target = new URL(env.BASE_URL ?? '')
  if (!['http:', 'https:'].includes(target.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password) throw new Error('Local return origin required')
  const returnUrl = `${target.origin}/orgs/${orgId}/settings/billing`
  const attempt = await env.AQUILLA_PG.prepare(`SELECT id, account_id
    FROM workspace_checkout_attempts WHERE org_id = ? AND resolved_at IS NULL`)
    .bind(orgId).first<{ id: string; account_id: string }>()
  if (!attempt) throw new WorkspaceCheckoutConflict('Subscription origin requires reconciliation')
  // Portal access is customer-wide. Never expose another workspace's billing.
  const shared = await env.AQUILLA_PG.prepare(`SELECT org_id FROM workspace_plan_entitlements
    WHERE stripe_customer_id = ? AND org_id <> ?
    UNION ALL SELECT org_id FROM org_billing WHERE stripe_customer_id = ? LIMIT 1`)
    .bind(stored.stripe_customer_id, orgId, stored.stripe_customer_id).first()
  if (shared) throw new WorkspaceCheckoutConflict('Shared billing customer requires reconciliation')
  const account = await stripeForm(env, 'GET', '/account')
  if (account.id !== attempt.account_id) throw new Error('Stripe account mismatch')
  const portal = configurationSchema.parse(await stripeForm(env, 'GET',
    `/billing_portal/configurations/${configuration}`))
  if (portal.id !== configuration) throw new Error('Portal configuration mismatch')
  const subscription = await stripeForm(env, 'GET',
    `/subscriptions/${encodeURIComponent(stored.stripe_subscription_id)}`)
  const metadata = subscription.metadata as Record<string, unknown> | undefined
  if (subscription.id !== stored.stripe_subscription_id || subscription.livemode !== false
    || subscription.customer !== stored.stripe_customer_id
    || metadata?.checkoutAttemptId !== attempt.id || metadata?.orgId !== String(orgId)) {
    throw new Error('Subscription customer mismatch')
  }
  const session = await stripeForm(env, 'POST', '/billing_portal/sessions', {
    customer: stored.stripe_customer_id, configuration, return_url: returnUrl,
  })
  const url = typeof session.url === 'string' ? new URL(session.url) : null
  if (session.livemode !== false || session.customer !== stored.stripe_customer_id
    || session.configuration !== configuration || session.return_url !== returnUrl
    || !url || url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com'
    || url.username || url.password || url.port) throw new Error('Invalid portal session')
  return { url: url.toString(), sandbox: true }
}
