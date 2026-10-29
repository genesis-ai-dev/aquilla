// AQU-2067 (unified billing T10): the platform-admin side of the one plan per
// org (spec §4) and the shadow-mode would-block report (spec §5.4).
import type { AllowancePolicy } from '../../../../db/shared/allowance-policy'
import { teamWeeklyRawUsd } from '../../../../db/shared/allowance-policy'
import { MICRO_UNITS_PER_UNIT, type CostRail } from '../../../../db/shared/billing-cost'
import type { OrgTier } from '../../../../db/shared/org-plan'
import { resolveOrgPlan } from '../../../../db/shared/org-plan'
import { readUsageTotals } from '../../../../db/shared/workspace-usage'

/** Spec Q4/Q7: size Team against the lower weekly revenue, the annual price. */
export const TEAM_ANNUAL_PRICE_USD = 5_000
/** Spec Q7: Team at 100% use may cost at most this share of Team revenue. */
export const TEAM_MAX_COST_SHARE = 0.25
const WEEKS_PER_YEAR = 52
/** raw_micro_cents → USD: 1e6 micro-cents per cent, 100 cents per dollar. */
const RAW_MICRO_CENTS_PER_USD = 100 * 1_000_000

export interface TeamCostCheck {
  teamWeeklyRawUsd: number
  teamWeeklyRevenueUsd: number
  /** Team's raw cost at 100% use as a share of its weekly revenue. */
  costShareOfRevenue: number
  maxCostShare: number
  exceedsMaxShare: boolean
}

/** Team scales with Free, so every Free change moves Team's worst-case cost.
 * The admin must see that cost, and a warning when it passes 25% of revenue. */
export function teamCostCheck(policy: AllowancePolicy): TeamCostCheck {
  const teamRaw = teamWeeklyRawUsd(policy)
  const revenue = TEAM_ANNUAL_PRICE_USD / WEEKS_PER_YEAR
  const share = teamRaw / revenue
  return {
    teamWeeklyRawUsd: teamRaw,
    teamWeeklyRevenueUsd: revenue,
    costShareOfRevenue: share,
    maxCostShare: TEAM_MAX_COST_SHARE,
    exceedsMaxShare: share > TEAM_MAX_COST_SHARE,
  }
}

/** Postgres undefined_column: migration 0182 is not applied on this database. */
export function isMissingColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return e?.code === '42703' || (typeof e?.message === 'string' && /column .* does not exist/.test(e.message))
}

export interface WouldBlockRow {
  org_id: number; org_name: string | null
  user_id: number | null; username: string | null
  rail: CostRail; is_current: boolean
  requests: number; raw_micro_cents: number; last_at: string
}

export interface WouldBlockPeriod {
  requests: number
  rawUsd: number
  byRail: Partial<Record<CostRail, number>>
  /** userId null is the system (background work with no live user). */
  users: { userId: number | null; username: string | null; requests: number; rails: CostRail[] }[]
}

export interface WouldBlockOrg {
  orgId: number
  orgName: string | null
  current: WouldBlockPeriod
  previous: WouldBlockPeriod
  lastAt: string
  tier?: OrgTier
  /** Committed metered usage as a share of this period's allowance; null = unmetered. */
  pctUsed?: number | null
}

const emptyPeriod = (): WouldBlockPeriod => ({ requests: 0, rawUsd: 0, byRail: {}, users: [] })

/** Folds per (org, user, rail, period) counts into one entry per org, most
 * would-blocks this period first, so the review starts with the orgs that
 * enforcement would hurt most. */
export function summarizeWouldBlock(rows: WouldBlockRow[]): WouldBlockOrg[] {
  const orgs = new Map<number, WouldBlockOrg>()
  for (const row of rows) {
    const requests = Number(row.requests)
    let org = orgs.get(row.org_id)
    if (!org) {
      org = { orgId: row.org_id, orgName: row.org_name, current: emptyPeriod(), previous: emptyPeriod(), lastAt: row.last_at }
      orgs.set(row.org_id, org)
    }
    if (Date.parse(row.last_at) > Date.parse(org.lastAt)) org.lastAt = row.last_at
    const period = row.is_current ? org.current : org.previous
    period.requests += requests
    period.rawUsd += Number(row.raw_micro_cents) / RAW_MICRO_CENTS_PER_USD
    period.byRail[row.rail] = (period.byRail[row.rail] ?? 0) + requests
    let user = period.users.find(u => u.userId === row.user_id)
    if (!user) {
      user = { userId: row.user_id, username: row.username, requests: 0, rails: [] }
      period.users.push(user)
    }
    user.requests += requests
    if (!user.rails.includes(row.rail)) user.rails.push(row.rail)
  }
  const result = [...orgs.values()]
  for (const org of result) {
    for (const period of [org.current, org.previous]) period.users.sort((a, b) => b.requests - a.requests)
  }
  return result.sort((a, b) => b.current.requests - a.current.requests
    || b.previous.requests - a.previous.requests || a.orgId - b.orgId)
}

/** Would-block rows from each org's current and previous weekly period. Rows
 * carry their own period, so an org's period anchor needs no lookup: a period
 * that has not ended is current, one that ended in the last 7 days is previous. */
export async function readWouldBlockReport(db: AquillaDb, now = new Date()): Promise<WouldBlockOrg[]> {
  const nowIso = now.toISOString()
  const { results } = await db.prepare(`SELECT r.org_id, o.name AS org_name, r.user_id, u.username, r.rail,
      (r.period_end > ?::timestamptz) AS is_current,
      COUNT(*) AS requests, COALESCE(SUM(r.raw_micro_cents), 0) AS raw_micro_cents,
      MAX(r.created_at)::text AS last_at
    FROM workspace_usage_requests r
    JOIN organizations o ON o.id = r.org_id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.decision = 'would_block'
      AND r.period_end > ?::timestamptz - interval '7 days'
      AND r.period_start <= ?::timestamptz
      -- Both periods lie inside the last 14 days; this bound uses idx_workspace_usage_created.
      AND r.created_at > ?::timestamptz - interval '14 days'
    GROUP BY 1, 2, 3, 4, 5, 6`)
    .bind(nowIso, nowIso, nowIso, nowIso).all<WouldBlockRow>()
  const orgs = summarizeWouldBlock(results)
  // Tier and % used are the evidence for the enforce flip (spec §5.4).
  for (const org of orgs) {
    const plan = await resolveOrgPlan(db, org.orgId, now)
    if (!plan) continue
    org.tier = plan.tier
    if (plan.weeklyAllowanceUnits === null) { org.pctUsed = null; continue }
    const totals = await readUsageTotals(db, org.orgId, plan.period)
    // A zero allowance with any use reads as full, not as an unserializable Infinity.
    org.pctUsed = plan.weeklyAllowanceUnits > 0
      ? totals.committed / (plan.weeklyAllowanceUnits * MICRO_UNITS_PER_UNIT)
      : totals.committed > 0 ? 1 : 0
  }
  return orgs
}
