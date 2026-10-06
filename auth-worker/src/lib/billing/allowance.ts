import type { AquillaDb } from '../../../../db/shim/postgres'
import type { BillingWorkspace } from '../../../../db/shared/billing-workspace'
import { weeklyAllowance } from './pricing-model'

/** The project's workspace owns capacity, including personal-user grants. */
export async function readWeeklyAllowance(db: AquillaDb, workspace: BillingWorkspace) {
  const grant = await db.prepare('SELECT weekly_allowance FROM org_billing WHERE org_id = ?')
    .bind(workspace.orgId).first<{ weekly_allowance: number | null }>()
  if (grant?.weekly_allowance != null) return Number(grant.weekly_allowance)
  if (!['ready', 'already_subscribed'].includes(workspace.eligibility.reason)) return null
  if (workspace.entitlement && !workspace.entitlement.access) return null
  const offer = workspace.entitlement?.access?.offer ?? 'free'
  if (offer !== 'free') return weeklyAllowance(offer)
  return readFreeWeeklyAllowance(db)
}

export async function readFreeWeeklyAllowance(db: AquillaDb) {
  const policy = await db.prepare('SELECT settings FROM platform_settings WHERE id = 1')
    .first<{ settings: string }>()
  if (!policy) return weeklyAllowance('free')
  const value = (JSON.parse(policy.settings) as { fieldPlan?: { freeWeeklyAllowance?: unknown } })
    .fieldPlan?.freeWeeklyAllowance
  if (value === undefined) return weeklyAllowance('free')
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error('Invalid Free weekly allowance')
  }
  return value
}
