import type { AquillaDb } from '../shim/postgres'
import {
  rawUsdToAllowanceUnits, readAllowancePolicy, teamWeeklyRawUsd, weeklyUsagePeriod,
} from './allowance-policy'
import { resolveWorkspaceAccess, type WorkspaceAccess } from './workspace-access'

/** AQU-2059 (unified billing T3, spec §4.2): every org has exactly one plan. */
export type OrgTier = 'free' | 'team' | 'enterprise'

/** Spec Q5: after an Enterprise contract ends the org keeps a Team-sized
 * allowance this long, then becomes Free. */
export const ENTERPRISE_GRACE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export type OrgPlanSource =
  /** No org_billing tier: every org is Free by default. */
  | 'default'
  /** org_billing.tier (backfill or a platform admin). */
  | 'stored'
  /** A paid Stripe Team entitlement, including its past-due grace. */
  | 'stripe'
  /** Enterprise whose contract ended less than ENTERPRISE_GRACE_DAYS ago. */
  | 'contract_grace'

export interface OrgPlan {
  orgId: number
  tier: OrgTier
  source: OrgPlanSource
  /** Meter units per week. null = unmetered (Enterprise): recorded, never blocked. */
  weeklyAllowanceUnits: number | null
  /** The weekly usage period that admission and display share. */
  period: { start: string; end: string }
  contractEndsAt: string | null
  /** Set only while source is 'contract_grace'. */
  graceEndsAt?: string
  /** Stripe access, when the org has a paid entitlement. */
  workspaceAccess?: WorkspaceAccess
}

/** Legacy org_billing.plan vocabulary (none | explore | field | enterprise).
 * Rows written before 0182, or by the legacy Field webhook, have no tier. */
export function tierFromLegacyPlan(plan: string | null | undefined): OrgTier {
  if (plan === 'field') return 'team'
  if (plan === 'enterprise') return 'enterprise'
  return 'free'
}

/** Enterprise with no end date, or one in the future, is current. After it ends
 * the org gets ENTERPRISE_GRACE_DAYS at Team size, then nothing (null): the
 * caller falls through to Stripe or Free. */
export function resolveEnterpriseContract(contractEndsAt: string | null, now: Date):
  { tier: 'enterprise' } | { tier: 'team'; graceEndsAt: string } | null {
  if (contractEndsAt === null) return { tier: 'enterprise' }
  const end = Date.parse(contractEndsAt)
  if (!Number.isFinite(end) || !Number.isFinite(now.getTime())) throw new Error('Invalid contract end')
  if (now.getTime() < end) return { tier: 'enterprise' }
  const graceEnd = end + ENTERPRISE_GRACE_DAYS * DAY_MS
  if (now.getTime() < graceEnd) return { tier: 'team', graceEndsAt: new Date(graceEnd).toISOString() }
  return null
}

/** The one plan resolver. Returns null only when the org does not exist.
 * `billing_scope` and checkout eligibility play no part: a personal workspace
 * or an unconfirmed org is Free like any other (spec §4.2, §5.1).
 *
 * Precedence: current Enterprise contract → Enterprise grace (Team-sized) →
 * paid Stripe Team → stored tier → Free.
 */
export async function resolveOrgPlan(db: AquillaDb, orgId: number, now = new Date()): Promise<OrgPlan | null> {
  // tier and contract_ends_at come from 0182. Reading them through to_jsonb
  // yields NULL where 0182 is not applied yet, instead of an undefined-column
  // error, so these workers can deploy before the migration: a NULL tier falls
  // back to the legacy plan. One statement, so it is safe inside the usage
  // transaction. Read the columns directly once 0182 is applied everywhere.
  const row = await db.prepare(`SELECT o.created_at::text AS created_at,
      to_jsonb(b) ->> 'tier' AS tier, b.plan,
      to_jsonb(b) ->> 'contract_ends_at' AS contract_ends_at, b.weekly_allowance,
      e.offer, e.usage_anchor::text AS usage_anchor,
      s.payment_failed, s.paid_through::text AS paid_through, s.cancel_at_period_end
    FROM organizations o
    LEFT JOIN org_billing b ON b.org_id = o.id
    LEFT JOIN workspace_plan_entitlements e ON e.org_id = o.id
    LEFT JOIN workspace_subscription_state s ON s.org_id = o.id
    WHERE o.id = ?`).bind(orgId).first<{
      created_at: string; tier: OrgTier | null; plan: string | null
      contract_ends_at: string | null; weekly_allowance: number | null
      offer: 'team' | null; usage_anchor: string | null
      payment_failed: boolean | null; paid_through: string | null; cancel_at_period_end: boolean | null
    }>()
  if (!row) return null
  const stored: OrgTier | null = row.tier ?? (row.plan != null ? tierFromLegacyPlan(row.plan) : null)
  const contractEndsAt = row.contract_ends_at === null ? null
    : new Date(Date.parse(row.contract_ends_at)).toISOString()

  // A Stripe entitlement without a proven paid period is not Team yet.
  const workspaceAccess = row.offer && row.paid_through ? resolveWorkspaceAccess({
    offer: row.offer, paymentFailed: row.payment_failed === true,
    paidThrough: row.paid_through, cancelAtPeriodEnd: row.cancel_at_period_end === true,
  }, now) : undefined

  let tier: OrgTier = 'free'
  let source: OrgPlanSource = 'default'
  let graceEndsAt: string | undefined
  const contract = stored === 'enterprise' ? resolveEnterpriseContract(contractEndsAt, now) : null
  if (contract) {
    tier = contract.tier
    source = contract.tier === 'enterprise' ? 'stored' : 'contract_grace'
    if ('graceEndsAt' in contract) graceEndsAt = contract.graceEndsAt
  } else if (workspaceAccess?.offer === 'team') {
    tier = 'team'; source = 'stripe'
  } else if (stored === 'team') {
    tier = 'team'; source = 'stored'
  } else if (stored !== null) {
    source = 'stored'
  }

  const policy = await readAllowancePolicy(db)
  // The per-org admin override (units) beats the plan default for metered plans.
  const weeklyAllowanceUnits = tier === 'enterprise' ? null
    : row.weekly_allowance != null ? Number(row.weekly_allowance)
      : rawUsdToAllowanceUnits(tier === 'team' ? teamWeeklyRawUsd(policy) : policy.freeWeeklyRawUsd)
  // Billing never resets usage: a Stripe org keeps its activation anchor even
  // after falling back to Free; everyone else anchors to org creation.
  const period = weeklyUsagePeriod(row.usage_anchor ?? row.created_at, now.toISOString())
  return {
    orgId, tier, source, weeklyAllowanceUnits, period, contractEndsAt,
    ...(graceEndsAt ? { graceEndsAt } : {}),
    ...(workspaceAccess ? { workspaceAccess } : {}),
  }
}
