import type { AquillaDb } from '../../../../db/shim/postgres'
import type { BillingWorkspace } from '../../../../db/shared/billing-workspace'
import { resolveAllowancePolicy, weeklyAllowance, type AllowancePolicy } from './pricing-model'

/** The project's workspace owns capacity, including personal-user grants.
 * Returns meter units; a per-org admin grant beats every plan default.
 */
export async function readWeeklyAllowance(db: AquillaDb, workspace: BillingWorkspace) {
  const grant = await db.prepare('SELECT weekly_allowance FROM org_billing WHERE org_id = ?')
    .bind(workspace.orgId).first<{ weekly_allowance: number | null }>()
  if (grant?.weekly_allowance != null) return Number(grant.weekly_allowance)
  if (!['ready', 'already_subscribed'].includes(workspace.eligibility.reason)) return null
  if (workspace.entitlement && !workspace.entitlement.access) return null
  const offer = workspace.entitlement?.access?.offer ?? 'free'
  return weeklyAllowance(offer, 1, await readAllowancePolicy(db))
}

export async function readFreeWeeklyAllowance(db: AquillaDb) {
  return weeklyAllowance('free', 1, await readAllowancePolicy(db))
}

/** Global raw-dollar policy from platform_settings.fieldPlan. */
export async function readAllowancePolicy(db: AquillaDb): Promise<AllowancePolicy> {
  const policy = await db.prepare('SELECT settings FROM platform_settings WHERE id = 1')
    .first<{ settings: string }>()
  const fieldPlan = policy
    ? (JSON.parse(policy.settings) as { fieldPlan?: { freeWeeklyRawUsd?: unknown; teamMultipleOfFree?: unknown } }).fieldPlan
    : undefined
  return resolveAllowancePolicy(fieldPlan)
}
