import type { AquillaDb } from '../../../../db/shim/postgres'
import { MICRO_UNITS_PER_UNIT, quoteProviderCost, type CostRail } from '../../../../db/shared/billing-cost'
import { readBillingWorkspace } from './workspace'
import { weeklyAllowance, weeklyUsagePeriod } from './pricing-model'

export const OVERAGE_FACTOR = 1.05

interface UsageRequest {
  org_id: number; request_id: string; user_id: number; project_id: string
  rail: CostRail; rate_version: string; multiplier: number
  period_start: string; period_end: string; reserved_micro_units: number
  state: 'reserved' | 'settled' | 'released'
  raw_micro_cents: number | null; settled_micro_units: number | null
  provider_ref: string | null; created_at: string
}
const columns = `org_id, request_id, user_id, project_id, rail, rate_version,
  multiplier, period_start::text, period_end::text, reserved_micro_units,
  state, raw_micro_cents, settled_micro_units, provider_ref, created_at::text`

export function validProviderRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.trim().length > 0 && ref.length <= 200 && ref.trim() === ref
}
/** A stored reference identifies the provider's generation record. Once set it
 * cannot change: a different id means the request would be billed for someone
 * else's work, so reject instead of overwriting.
 */
async function attachProviderRef(tx: AquillaDb, request: UsageRequest, providerRef: string | undefined) {
  if (providerRef === undefined) return
  if (!validProviderRef(providerRef)) throw new Error('Invalid usage provider reference')
  if (request.provider_ref !== null) {
    if (request.provider_ref !== providerRef) throw new Error('Usage provider reference conflict')
    return
  }
  await tx.prepare('UPDATE workspace_usage_requests SET provider_ref = ? WHERE org_id = ? AND request_id = ?')
    .bind(providerRef, request.org_id, request.request_id).run()
}

function readRequest(db: AquillaDb, orgId: number, requestId: string) {
  return db.prepare(`SELECT ${columns} FROM workspace_usage_requests
    WHERE org_id = ? AND request_id = ?`).bind(orgId, requestId).first<UsageRequest>()
}
async function locked<T>(db: AquillaDb, orgId: number, fn: (tx: AquillaDb) => Promise<T>) {
  if (!db.transaction) throw new Error('Usage accounting requires transactions')
  return db.transaction(async tx => {
    const org = await tx.prepare('SELECT id FROM organizations WHERE id = ? FOR UPDATE')
      .bind(orgId).first()
    if (!org) throw new Error('Usage workspace does not exist')
    return fn(tx)
  })
}

export async function readUsageTotals(db: AquillaDb, orgId: number, period: { start: string; end: string }) {
  const totals = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'reserved' THEN reserved_micro_units ELSE 0 END), 0) AS reserved,
    COALESCE(SUM(CASE WHEN state = 'settled' THEN settled_micro_units ELSE 0 END), 0) AS settled
    FROM workspace_usage_requests WHERE org_id = ?
    AND period_start = ?::timestamptz AND period_end = ?::timestamptz`)
    .bind(orgId, period.start, period.end).first<{ reserved: number; settled: number }>()
  const reserved = Number(totals?.reserved)
  const settled = Number(totals?.settled)
  if (![reserved, settled, reserved + settled].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Usage totals unavailable')
  }
  return { reserved, settled, committed: reserved + settled }
}

/** Internal admission only: the caller must authorize the user/project first.
 * Reserve a server-calculated upper bound BEFORE starting a provider request.
 * A replay returns created:false; it never authorizes a second provider call.
 */
export async function reserveWorkspaceUsage(db: AquillaDb, input: {
  orgId: number; projectId: string; userId: number; requestId: string
  rail: CostRail; maxRawCostCents: number
}, now = new Date()) {
  const quote = quoteProviderCost(input.maxRawCostCents, input.rail)
  if (!input.requestId.trim() || input.requestId.length > 200 || quote.microUnits <= 0
    || !Number.isFinite(now.getTime())) throw new Error('Invalid usage reservation')
  return locked(db, input.orgId, async tx => {
    const project = await tx.prepare('SELECT org_id FROM projects WHERE id = ?')
      .bind(input.projectId).first<{ org_id: number | null }>()
    if (project?.org_id !== input.orgId) throw new Error('Usage project belongs to another workspace')
    const prior = await readRequest(tx, input.orgId, input.requestId)
    if (prior) {
      if (prior.user_id !== input.userId || prior.project_id !== input.projectId
        || prior.rail !== input.rail || prior.rate_version !== quote.rateVersion
        || prior.reserved_micro_units !== quote.microUnits) throw new Error('Usage request identity conflict')
      return { created: false, request: prior }
    }
    const workspace = await readBillingWorkspace(tx, input.orgId, now)
    if (!workspace || !['ready', 'already_subscribed'].includes(workspace.eligibility.reason)) {
      throw new Error('Workspace usage requires an explicit supported entitlement')
    }
    if (workspace.entitlement && !workspace.entitlement.access) {
      throw new Error('Paid workspace access is unresolved')
    }
    const org = await tx.prepare('SELECT created_at::text FROM organizations WHERE id = ?')
      .bind(input.orgId).first<{ created_at: string }>()
    const period = workspace.entitlement ? {
      start: workspace.entitlement.usagePeriodStart, end: workspace.entitlement.usagePeriodEnd,
    } : weeklyUsagePeriod(org!.created_at, now.toISOString())
    const allowance = weeklyAllowance(workspace.entitlement?.access?.offer ?? 'free') * MICRO_UNITS_PER_UNIT
    const totals = await readUsageTotals(tx, input.orgId, period)
    // Decision 2026-09-16: nothing new starts at or past 100%, but a bounded
    // request may finish up to 5% over so a pessimistic bound does not strand
    // the last step of the week. Customers only ever see 100%.
    if (totals.committed >= allowance || totals.committed + quote.microUnits > allowance * OVERAGE_FACTOR) {
      throw new Error('Weekly AI allowance exhausted')
    }
    await tx.prepare(`INSERT INTO workspace_usage_requests
      (org_id, request_id, user_id, project_id, rail, rate_version, multiplier,
       period_start, period_end, reserved_micro_units)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?)`)
      .bind(input.orgId, input.requestId, input.userId, input.projectId, input.rail,
        quote.rateVersion, quote.multiplier, period.start, period.end, quote.microUnits).run()
    return { created: true, request: (await readRequest(tx, input.orgId, input.requestId))! }
  })
}

/** Record actual provider spend even if it exceeds the reservation; never hide
 * an overrun. Subsequent admission sees the actual total and stops further work.
 * Unknown spend must keep its reservation until authoritative reconciliation.
 */
export async function settleWorkspaceUsage(db: AquillaDb, orgId: number, requestId: string, rawCostCents: number, providerRef?: string) {
  return locked(db, orgId, async tx => {
    const request = await readRequest(tx, orgId, requestId)
    if (!request) throw new Error('Usage reservation not found')
    await attachProviderRef(tx, request, providerRef)
    const quote = quoteProviderCost(rawCostCents, request.rail)
    if (quote.rateVersion !== request.rate_version || quote.multiplier !== request.multiplier) {
      throw new Error('Usage rate version mismatch')
    }
    if (request.state === 'settled') {
      if (request.raw_micro_cents !== quote.rawMicroCents) throw new Error('Usage settlement conflict')
      return false
    }
    if (request.state !== 'reserved') throw new Error('Usage reservation already released')
    await tx.prepare(`UPDATE workspace_usage_requests SET state = 'settled',
      raw_micro_cents = ?, settled_micro_units = ?, resolved_at = now()
      WHERE org_id = ? AND request_id = ?`)
      .bind(quote.rawMicroCents, quote.microUnits, orgId, requestId).run()
    return true
  })
}

/** Only call when no provider work started, or the provider proves no charge.
 * Timeouts, process loss, and uncertain responses are NOT evidence for release.
 */
export async function releaseWorkspaceUsage(db: AquillaDb, orgId: number, requestId: string) {
  return locked(db, orgId, async tx => {
    const request = await readRequest(tx, orgId, requestId)
    if (!request) throw new Error('Usage reservation not found')
    if (request.state === 'released') return false
    if (request.state !== 'reserved') throw new Error('Settled usage cannot be released')
    await tx.prepare(`UPDATE workspace_usage_requests SET state = 'released', resolved_at = now()
      WHERE org_id = ? AND request_id = ?`).bind(orgId, requestId).run()
    return true
  })
}

/** Record which provider generation a held reservation belongs to, so it can be
 * reconciled later from the provider's own record. This never settles usage.
 */
export async function recordUsageProviderRef(db: AquillaDb, orgId: number, requestId: string, providerRef: string) {
  return locked(db, orgId, async tx => {
    const request = await readRequest(tx, orgId, requestId)
    if (!request) throw new Error('Usage reservation not found')
    await attachProviderRef(tx, request, providerRef)
  })
}
export function readUsageRequest(db: AquillaDb, orgId: number, requestId: string) {
  return readRequest(db, orgId, requestId)
}
/** Reservations still awaiting settlement, oldest first. */
export async function listHeldUsage(db: AquillaDb, orgId: number, limit = 100) {
  const rows = await db.prepare(`SELECT ${columns} FROM workspace_usage_requests
    WHERE org_id = ? AND state = 'reserved' ORDER BY created_at ASC LIMIT ?`)
    .bind(orgId, limit).all<UsageRequest>()
  return rows.results
}

/** Customer-facing usage: the same allowance and period admission uses, so the
 * percentage can never disagree with enforcement. Display caps at 100 while
 * the ledger keeps the true overrun. Returns null rather than a fabricated
 * zero for workspaces without a measured allowance.
 */
export async function readWorkspaceUsageSummary(db: AquillaDb, orgId: number, now = new Date()) {
  const workspace = await readBillingWorkspace(db, orgId, now)
  if (!workspace || !['ready', 'already_subscribed'].includes(workspace.eligibility.reason)) return null
  if (workspace.entitlement && !workspace.entitlement.access) return null
  const org = await db.prepare('SELECT created_at::text FROM organizations WHERE id = ?')
    .bind(orgId).first<{ created_at: string }>()
  if (!org) return null
  const period = workspace.entitlement ? {
    start: workspace.entitlement.usagePeriodStart, end: workspace.entitlement.usagePeriodEnd,
  } : weeklyUsagePeriod(org.created_at, now.toISOString())
  const allowance = weeklyAllowance(workspace.entitlement?.access?.offer ?? 'free') * MICRO_UNITS_PER_UNIT
  const totals = await readUsageTotals(db, orgId, period)
  return { percent: Math.min(100, Math.floor((totals.committed / allowance) * 100)), resetsAt: period.end }
}
