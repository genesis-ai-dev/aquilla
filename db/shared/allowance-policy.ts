import type { AquillaDb } from '../shim/postgres'
import { costMultiplier } from './billing-cost'

/** AQU-2056: allowances are raw provider dollars per week. Team is a multiple
 * of Free so an admin change to Free moves Team with it (spec §4.3: Team at
 * 100% must stay within 25% of annual Team revenue).
 */
export interface AllowancePolicy { freeWeeklyRawUsd: number; teamMultipleOfFree: number }
export const DEFAULT_ALLOWANCE_POLICY: AllowancePolicy = { freeWeeklyRawUsd: 1, teamMultipleOfFree: 24 }

/** Missing fields take the default; a present but invalid value throws so a
 * bad admin save cannot silently become an unlimited or zero allowance.
 */
export function resolveAllowancePolicy(
  stored: { freeWeeklyRawUsd?: unknown; teamMultipleOfFree?: unknown } | undefined,
): AllowancePolicy {
  const free = stored?.freeWeeklyRawUsd ?? DEFAULT_ALLOWANCE_POLICY.freeWeeklyRawUsd
  const multiple = stored?.teamMultipleOfFree ?? DEFAULT_ALLOWANCE_POLICY.teamMultipleOfFree
  if (typeof free !== 'number' || !Number.isFinite(free) || free < 0 || free > 10_000) {
    throw new Error('Invalid Free weekly allowance')
  }
  if (typeof multiple !== 'number' || !Number.isFinite(multiple) || multiple < 1 || multiple > 1_000) {
    throw new Error('Invalid Team multiple of Free')
  }
  return { freeWeeklyRawUsd: free, teamMultipleOfFree: multiple }
}

export function teamWeeklyRawUsd(policy: AllowancePolicy): number {
  return policy.freeWeeklyRawUsd * policy.teamMultipleOfFree
}

/** The one raw-dollar → meter conversion. The meter counts units of one
 * marked-up cent (db/shared/billing-cost.ts); every rail shares one markup.
 * Units are internal: only admin screens may show them.
 */
export function rawUsdToAllowanceUnits(rawUsd: number): number {
  const units = Math.round(rawUsd * 100 * costMultiplier('llm'))
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('Invalid allowance')
  return units
}

/** Full seven-day periods, anchored to activation; billing never resets usage. */
export function weeklyUsagePeriod(anchorIso: string, nowIso: string) {
  const anchor = Date.parse(anchorIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(anchor) || !Number.isFinite(now) || now < anchor) {
    throw new Error('Invalid usage period timestamp')
  }
  const week = 7 * 24 * 60 * 60 * 1000
  const start = anchor + Math.floor((now - anchor) / week) * week
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + week).toISOString(),
  }
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
