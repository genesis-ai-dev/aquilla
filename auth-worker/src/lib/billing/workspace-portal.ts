import { z } from 'zod'
import type { Env } from '../../types'
import { catalogSchema, readValidatedBillingCatalog } from './catalog'
import type { BillingWorkspace } from '../../../../db/shared/billing-workspace'
import { stripeForm } from './stripe'
import { readWorkspaceEntitlement } from './workspace'
import { workspaceCheckoutRehearsalEnabled, WorkspaceCheckoutConflict } from './workspace-checkout'

const configurationSchema = z.object({
  id: z.string(), active: z.literal(true), livemode: z.literal(false),
  features: z.object({
    invoice_history: z.object({ enabled: z.literal(true) }),
    payment_method_update: z.object({ enabled: z.literal(true) }),
    subscription_update: z.object({ enabled: z.boolean(),
      proration_behavior: z.string().optional(), billing_cycle_anchor: z.string().optional(),
      default_allowed_updates: z.array(z.string()).optional(),
      schedule_at_period_end: z.object({ conditions: z.array(z.unknown()) }).optional(),
      products: z.array(z.object({ product: z.string(), prices: z.array(z.string()),
        adjustable_quantity: z.object({ enabled: z.boolean() }),
      })).optional(),
    }),
    subscription_cancel: z.object({ enabled: z.boolean(), mode: z.string().optional(),
      proration_behavior: z.string().optional() }),
    subscription_pause: z.object({ enabled: z.literal(false) }).optional(),
  }),
})

/** Stripe owns confirmation and billing; session creation never grants access. */
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
    `/billing_portal/configurations/${configuration}?expand%5B%5D=features.subscription_update.products`))
  if (portal.id !== configuration) throw new Error('Portal configuration mismatch')
  const update = portal.features.subscription_update
  const cancel = portal.features.subscription_cancel
  if (update.enabled || cancel.enabled) {
    const { catalog } = await readValidatedBillingCatalog(env)
    if (catalog.accountId !== attempt.account_id || catalog.checkoutLayout !== 'single_item'
      || catalog.version !== stored.price_version || catalog.entitlementVersion !== stored.entitlement_version) {
      throw new Error('Native portal requires the matching single-item catalog')
    }
    if (cancel.enabled && (cancel.mode !== 'at_period_end' || cancel.proration_behavior !== 'none')) {
      throw new Error('Cancellation must preserve the paid period')
    }
    if (update.enabled) {
      const expected = catalog.bindings.filter(b =>
        (b.offer.startsWith('team') ? 'team' : 'personal') === stored.scope)
        .map(b => `${b.productId}:${b.priceId}`).sort()
      const actual = update.products?.flatMap(p => p.prices.map(price => `${p.product}:${price}`)).sort()
      if (update.proration_behavior !== 'always_invoice' || update.billing_cycle_anchor !== 'unchanged'
        || JSON.stringify(update.default_allowed_updates) !== JSON.stringify(['price'])
        || update.schedule_at_period_end?.conditions.length !== 0
        || update.products?.some(p => p.adjustable_quantity.enabled)
        || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('Portal plan changes do not match the approved catalog and policy')
      }
    }
  }
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

/** Summary capability only; session creation still verifies live Stripe facts. */
export function workspacePortalAvailable(env: Env, requestUrl: string, workspace: BillingWorkspace) {
  if (!workspace.entitlement || !workspaceCheckoutRehearsalEnabled(env, requestUrl)) return false
  try {
    const catalog = catalogSchema.parse(JSON.parse(env.STRIPE_PRICE_CATALOG ?? 'null'))
    const id = workspace.entitlement.scope === 'personal'
      ? env.STRIPE_PORTAL_PERSONAL_CONFIGURATION : env.STRIPE_PORTAL_TEAM_CONFIGURATION
    return catalog.checkoutLayout === 'single_item'
      && catalog.version === workspace.entitlement.priceVersion
      && catalog.entitlementVersion === workspace.entitlement.entitlementVersion
      && /^bpc_[a-zA-Z0-9]+$/.test(id ?? '')
  } catch { return false }
}
