import type { AquillaDb } from '../../../../db/shim/postgres'
import type { BillingWorkspace, WorkspaceScope } from '../../../../db/shared/billing-workspace'
import type { Offer } from './pricing-model'
import { weeklyUsagePeriod } from './pricing-model'

type PaidOffer = Exclude<Offer, 'free'>
export interface StoredWorkspaceEntitlement {
  org_id: number
  offer: PaidOffer
  scope: WorkspaceScope
  quantity: number
  price_version: string
  entitlement_version: string
  price_ids: string[]
  stripe_subscription_id: string
  stripe_customer_id: string
  billing_interval: 'month' | 'year'
  usage_anchor: string
}
export function readWorkspaceEntitlement(db: AquillaDb, orgId: number) {
  return db.prepare(`SELECT org_id, offer, scope, quantity, price_version,
    entitlement_version, price_ids, stripe_subscription_id, stripe_customer_id,
    billing_interval, usage_anchor::text FROM workspace_plan_entitlements
    WHERE org_id = ?`).bind(orgId).first<StoredWorkspaceEntitlement>()
}

/** Optional AQU-1212 partner store: absence is compatible, database failures are not. */
export async function hasPartnerAccess(db: AquillaDb, orgId: number) {
  const exists = await db.prepare(
    "SELECT to_regclass('public.org_entitlements') IS NOT NULL AS present",
  ).first<{ present: boolean }>()
  if (!exists?.present) return false
  const row = await db.prepare(
    'SELECT org_id FROM org_entitlements WHERE org_id = ? AND active = true',
  ).bind(orgId).first()
  return row !== null
}

export async function readBillingWorkspace(
  db: AquillaDb, orgId: number, now = new Date(),
): Promise<BillingWorkspace | null> {
  const org = await db.prepare(`SELECT o.id, o.name, o.billing_scope,
    b.plan, b.status, b.stripe_customer_id, b.stripe_subscription_id,
    b.hard_cap_words, b.complimentary_words,
    EXISTS (SELECT 1 FROM org_members m
      WHERE m.org_id = o.id AND m.user_id <> o.owner_user_id)
      OR EXISTS (SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
        WHERE p.org_id = o.id AND pm.user_id <> o.owner_user_id)
      OR EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE g.org_id = o.id AND gm.user_id <> o.owner_user_id) AS collaborators
    FROM organizations o LEFT JOIN org_billing b ON b.org_id = o.id
    WHERE o.id = ?`).bind(orgId).first<{
      id: number; name: string | null; billing_scope: WorkspaceScope | null
      plan: string | null; status: string | null
      stripe_customer_id: string | null; stripe_subscription_id: string | null
      hard_cap_words: number | null; complimentary_words: number | null
      collaborators: boolean
    }>()
  if (!org) return null
  const stored = await readWorkspaceEntitlement(db, orgId)
  let reason: BillingWorkspace['eligibility']['reason'] = 'ready'
  if (await hasPartnerAccess(db, orgId)) reason = 'covered_access'
  else if (stored) reason = 'already_subscribed'
  else if (org.stripe_customer_id || org.stripe_subscription_id
    || (org.plan != null && !['none', 'explore'].includes(org.plan))
    || (org.status != null && org.status !== 'none')
    || org.hard_cap_words != null || Number(org.complimentary_words ?? 0) > 0) {
    reason = 'existing_billing'
  } else if (!org.billing_scope) reason = 'scope_unconfirmed'
  else if (org.billing_scope === 'personal' && org.collaborators) {
    // Reviewer permissions remain a launch decision; do not silently classify guests.
    reason = 'personal_collaboration_review'
  }
  const period = stored ? weeklyUsagePeriod(stored.usage_anchor, now.toISOString()) : null
  return {
    orgId: org.id, name: org.name, scope: org.billing_scope,
    eligibility: { reason, offers: reason !== 'ready' ? [] : org.billing_scope === 'personal'
      ? ['pro', 'max_5x', 'max_20x'] : ['team', 'team_20x'] },
    entitlement: stored && period ? {
      offer: stored.offer, scope: stored.scope, billingInterval: stored.billing_interval,
      priceVersion: stored.price_version, entitlementVersion: stored.entitlement_version,
      usagePeriodStart: period.start, usagePeriodEnd: period.end,
    } : null,
    usagePercent: null, checkoutEnabled: false,
  }
}

/** Project ownership is authoritative; never fall back to the acting user's pool. */
export async function readProjectBillingWorkspace(
  db: AquillaDb, projectId: string, now = new Date(),
) {
  const project = await db.prepare('SELECT org_id FROM projects WHERE id = ?')
    .bind(projectId).first<{ org_id: number | null }>()
  if (!project?.org_id) return null
  return readBillingWorkspace(db, project.org_id, now)
}
