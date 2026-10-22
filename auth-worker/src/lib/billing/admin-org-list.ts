// The admin billing org list: one page of orgs, searched and filtered in SQL,
// with every row's snapshot and plan read in a fixed number of queries
// (word-snapshots.ts, resolveOrgPlans). Reading the whole platform one org at a
// time timed the Billing tab out.

import { readWordSnapshots } from "./word-snapshots"
import type { SnapshotCatalog } from "./words"
import { resolveOrgPlans, tierFromLegacyPlan, type OrgTier } from "../../../../db/shared/org-plan"

export const ADMIN_BILLING_PAGE_MAX = 200

/** `paid` is Team or Enterprise as set by an admin or the legacy plan. */
export type AdminBillingTierFilter = OrgTier | "paid"

export interface AdminBillingOrgQuery {
  /** Matches org name or owner username (substring), or the org id exactly. */
  q?: string
  tier?: AdminBillingTierFilter
  limit: number
  offset: number
  /** One org only — the detail read after an admin change. */
  orgId?: number
}

// The stored tier, or the legacy plan mapped the way tierFromLegacyPlan does.
// to_jsonb reads tier/contract_ends_at as NULL until migration 0182 is applied.
const STORED_TIER_SQL = `COALESCE(to_jsonb(b) ->> 'tier',
  CASE b.plan WHEN 'field' THEN 'team' WHEN 'enterprise' THEN 'enterprise' ELSE 'free' END)`

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

export async function readAdminBillingOrgs(db: AquillaDb, catalog: SnapshotCatalog, query: AdminBillingOrgQuery) {
  const where: string[] = []
  const binds: unknown[] = []
  if (query.orgId !== undefined) {
    where.push("o.id = ?")
    binds.push(query.orgId)
  }
  const q = query.q?.trim()
  if (q) {
    where.push("(o.name ILIKE ? OR u.username ILIKE ? OR o.id::text = ?)")
    binds.push(likePattern(q), likePattern(q), q)
  }
  if (query.tier === "paid") {
    where.push(`${STORED_TIER_SQL} IN ('team', 'enterprise')`)
  } else if (query.tier) {
    where.push(`${STORED_TIER_SQL} = ?`)
    binds.push(query.tier)
  }
  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, u.username AS owner_username, b.weekly_allowance, b.plan AS legacy_plan,
          to_jsonb(b) ->> 'tier' AS tier, to_jsonb(b) ->> 'contract_ends_at' AS contract_ends_at,
          COUNT(*) OVER () AS total
        FROM organizations o LEFT JOIN users u ON u.id = o.owner_user_id
        LEFT JOIN org_billing b ON b.org_id = o.id
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY o.name ASC NULLS LAST, o.id ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, query.limit, query.offset)
    .all<{
      id: number; name: string | null; owner_username: string | null; weekly_allowance: number | null
      legacy_plan: string | null; tier: OrgTier | null; contract_ends_at: string | null; total: number | string
    }>()
  const rows = results ?? []
  // COUNT(*) OVER () rides on every row; a page past the end has none, so it
  // cannot report the total. The UI only asks for pages it was told exist.
  const total = rows.length > 0 ? Number(rows[0].total) : 0
  const ids = rows.map((r) => Number(r.id))
  const [snaps, plans] = await Promise.all([readWordSnapshots(db, ids, catalog), resolveOrgPlans(db, ids)])

  const orgs = rows.map((org) => {
    const orgId = Number(org.id)
    const snap = snaps.get(orgId)!
    const resolved = plans.get(orgId)
    return {
      orgId,
      // AQU-2067: what an admin set (the control) and what the resolver
      // answers now (Stripe, contract grace), which can differ.
      tier: org.tier ?? tierFromLegacyPlan(org.legacy_plan),
      contractEndsAt: org.contract_ends_at === null ? null : new Date(Date.parse(org.contract_ends_at)).toISOString(),
      resolvedTier: resolved?.tier ?? "free",
      planSource: resolved?.source ?? "default",
      graceEndsAt: resolved?.graceEndsAt ?? null,
      effectiveWeeklyAllowance: resolved?.weeklyAllowanceUnits ?? null,
      ownerUsername: org.owner_username,
      weeklyAllowance: org.weekly_allowance,
      orgName: org.name,
      plan: snap.plan,
      status: snap.status,
      wordsUsed: snap.wordsUsed,
      allowanceWords: snap.allowanceWords,
      remainingWords: snap.remaining,
      addonPacks: snap.addonPacks,
      complimentaryWords: snap.complimentaryWords,
      hardCapWords: snap.hardCapWords,
      periodStart: snap.periodStart,
      periodEnd: snap.periodEnd,
      creditsUsed: snap.creditsUsed,
      allowanceCredits: snap.allowanceCredits,
      remainingCredits: snap.remainingCredits,
      complimentaryCredits: snap.complimentaryCredits,
      includedCredits: snap.includedCredits,
      languageCount: snap.languageCount,
      includedCreditsOverride: snap.includedCreditsOverride,
      billedLanguageCountOverride: snap.billedLanguageCountOverride,
      wordsPerCredit: snap.wordsPerCredit,
    }
  })
  return { orgs, total }
}
