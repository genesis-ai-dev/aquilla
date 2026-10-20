// AQU-2059 (unified billing T3): one plan per org. Why these tests matter:
// before T3, readWeeklyAllowance returned null for most real orgs (unconfirmed
// billing_scope, legacy Field/Enterprise, partner-covered), and null made every
// AI route answer 503 the moment metering turned on (spec §5.1). The resolver
// must give EVERY org a plan, the backfill must be safe to re-run, and an
// Enterprise contract must end in a Team-sized grace, then Free (spec Q5).
import app from '../index'
import { env, pg } from './helpers/pg-test-env'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ENTERPRISE_GRACE_DAYS, resolveOrgPlan } from '../../../db/shared/org-plan'
import { MICRO_UNITS_PER_UNIT } from '../../../db/shared/billing-cost'
import { upsertOrgBilling } from '../lib/billing/apply'
import { readUsageTotals, readWorkspaceUsageSummary, reserveWorkspaceUsage } from '../lib/billing/workspace-usage'

const MIGRATION = readFileSync(new URL('../../../db/postgres/migrations/0182_org_billing_tier.sql', import.meta.url), 'utf8')
const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-10-19T12:00:00Z')
// Default policy: Free $1/week raw = 400 units, Team 24× = 9,600 units.
const FREE_UNITS = 400
const TEAM_UNITS = 9_600

afterEach(async () => { await pg.exec('DROP TABLE IF EXISTS org_entitlements') })

async function org(id: number, scope: 'personal' | 'team' | null = 'team') {
  await env.AQUILLA_PG.prepare(`INSERT INTO organizations (id, name, owner_user_id, billing_scope, created_at)
    VALUES (?, ?, 1, ?, ?::timestamptz)`).bind(id, `org-${id}`, scope, '2026-09-01T00:00:00Z').run()
  return id
}
async function legacyRow(orgId: number, plan: string, extra = '') {
  // Simulate a pre-0182 row: the legacy plan with no tier yet.
  await pg.exec(`INSERT INTO org_billing (org_id, plan, status${extra ? ', stripe_customer_id' : ''})
    VALUES (${orgId}, '${plan}', '${plan === 'none' ? 'none' : 'active'}'${extra ? `, '${extra}'` : ''})`)
}
async function stripeTeam(orgId: number, opts: { paymentFailed?: boolean; paidThrough: string }) {
  await pg.exec(`INSERT INTO workspace_plan_entitlements (org_id, offer, scope, quantity, entitlement_version,
      price_version, price_ids, stripe_subscription_id, stripe_customer_id, billing_interval, usage_anchor)
    VALUES (${orgId}, 'team', 'team', 1, '2026-09-weekly', 'v1', '[]', 'sub_${orgId}', 'cus_${orgId}', 'month', '2026-10-01T00:00:00Z');
    INSERT INTO workspace_subscription_state (org_id, payment_failed, paid_through, cancel_at_period_end)
    VALUES (${orgId}, ${opts.paymentFailed === true}, '${opts.paidThrough}', false)`)
}
const tierOf = async (orgId: number, at = now) => (await resolveOrgPlan(env.AQUILLA_PG, orgId, at))?.tier

describe('prod-shaped fixture → backfill → every org has a plan', () => {
  async function fixture() {
    await org(1)                          // no org_billing row at all
    await org(2, null); await legacyRow(2, 'none')        // unconfirmed scope (most prod orgs)
    await org(3); await legacyRow(3, 'explore')
    await org(4); await legacyRow(4, 'field', 'cus_field') // legacy Field
    await org(5); await legacyRow(5, 'enterprise')        // legacy Enterprise
    await org(6, null)                                    // partner-covered, no billing row
    await org(7); await legacyRow(7, 'field')             // Field AND partner: partner wins
    await org(8, 'personal')                              // personal workspace
    await org(9); await stripeTeam(9, { paidThrough: '2026-11-01T00:00:00Z' })
    await pg.exec(`CREATE TABLE org_entitlements (org_id bigint PRIMARY KEY, active boolean NOT NULL);
      INSERT INTO org_entitlements VALUES (6, true), (7, true), (3, false)`)
  }
  const expected = { 1: 'free', 2: 'free', 3: 'free', 4: 'team', 5: 'enterprise', 6: 'enterprise', 7: 'enterprise', 8: 'free', 9: 'team' }

  it('maps legacy Field → Team, Enterprise or partner → Enterprise, the rest Free', async () => {
    await fixture()
    await pg.exec(MIGRATION)
    for (const [id, tier] of Object.entries(expected)) expect([id, await tierOf(Number(id))]).toEqual([id, tier])
    const stored = await pg.query<{ org_id: number; tier: string }>('SELECT org_id, tier FROM org_billing ORDER BY org_id')
    expect(stored.rows).toEqual([
      { org_id: 2, tier: 'free' }, { org_id: 3, tier: 'free' }, { org_id: 4, tier: 'team' },
      { org_id: 5, tier: 'enterprise' }, { org_id: 6, tier: 'enterprise' }, { org_id: 7, tier: 'enterprise' },
    ])
  })

  it('is idempotent: a second run changes no row and keeps an admin edit made in between', async () => {
    await fixture()
    await pg.exec(MIGRATION)
    // An admin downgrades the legacy Field org after the first run; a re-run
    // must not silently put it back on Team.
    await pg.exec("UPDATE org_billing SET tier = 'free' WHERE org_id = 4")
    const before = await pg.query('SELECT org_id, tier, updated_at FROM org_billing ORDER BY org_id')
    await pg.exec(MIGRATION)
    expect((await pg.query('SELECT org_id, tier, updated_at FROM org_billing ORDER BY org_id')).rows).toEqual(before.rows)
  })

  it('runs where the partner store is not installed', async () => {
    await org(5); await legacyRow(5, 'enterprise')
    await pg.exec(MIGRATION)
    expect(await tierOf(5)).toBe('enterprise')
  })

  it('resolves an un-backfilled legacy row from its plan, so a deploy before the migration is safe', async () => {
    await org(4); await legacyRow(4, 'field')
    expect(await tierOf(4)).toBe('team')
  })
})

describe('Enterprise contract end → 14-day Team-sized grace → Free', () => {
  async function enterprise(endsAt: string | null) {
    await org(5)
    await pg.exec(`INSERT INTO org_billing (org_id, plan, tier, contract_ends_at)
      VALUES (5, 'enterprise', 'enterprise', ${endsAt === null ? 'NULL' : `'${endsAt}'`})`)
  }
  const end = new Date('2026-10-10T00:00:00Z')

  it('is unmetered with no end date or before the end', async () => {
    await enterprise(null)
    expect(await resolveOrgPlan(env.AQUILLA_PG, 5, now)).toMatchObject({ tier: 'enterprise', weeklyAllowanceUnits: null })
    await pg.exec(`UPDATE org_billing SET contract_ends_at = '${end.toISOString()}'`)
    expect(await tierOf(5, new Date(end.getTime() - 1))).toBe('enterprise')
  })

  it('gets a Team-sized, metered allowance during grace and says when grace ends', async () => {
    await enterprise(end.toISOString())
    const graceEnd = new Date(end.getTime() + ENTERPRISE_GRACE_DAYS * DAY)
    expect(await resolveOrgPlan(env.AQUILLA_PG, 5, end)).toMatchObject({
      tier: 'team', source: 'contract_grace', weeklyAllowanceUnits: TEAM_UNITS, graceEndsAt: graceEnd.toISOString(),
    })
    expect(await tierOf(5, new Date(graceEnd.getTime() - 1))).toBe('team')
    expect(await resolveOrgPlan(env.AQUILLA_PG, 5, graceEnd)).toMatchObject({ tier: 'free', weeklyAllowanceUnits: FREE_UNITS })
  })

  it('falls back to a paid Stripe Team after grace, not to Free', async () => {
    await enterprise(end.toISOString())
    await stripeTeam(5, { paidThrough: '2026-12-01T00:00:00Z' })
    expect(await resolveOrgPlan(env.AQUILLA_PG, 5, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ tier: 'team', source: 'stripe' })
  })
})

describe('Stripe Team and per-org overrides', () => {
  it('keeps Team through the 7-day past-due grace, then Free on the same usage anchor', async () => {
    await org(9); await stripeTeam(9, { paymentFailed: true, paidThrough: '2026-10-15T00:00:00Z' })
    expect(await resolveOrgPlan(env.AQUILLA_PG, 9, new Date('2026-10-21T00:00:00Z'))).toMatchObject({ tier: 'team', source: 'stripe' })
    const lapsed = await resolveOrgPlan(env.AQUILLA_PG, 9, new Date('2026-10-23T00:00:00Z'))
    // Billing never resets usage: the period stays anchored to activation.
    expect(lapsed).toMatchObject({ tier: 'free', period: { start: '2026-10-22T00:00:00.000Z' } })
  })

  it('lets the admin per-org override beat the plan default, but never meters Enterprise', async () => {
    await org(2); await pg.exec("INSERT INTO org_billing (org_id, tier, weekly_allowance) VALUES (2, 'free', 50)")
    expect((await resolveOrgPlan(env.AQUILLA_PG, 2, now))?.weeklyAllowanceUnits).toBe(50)
    await pg.exec("UPDATE org_billing SET tier = 'enterprise'")
    expect((await resolveOrgPlan(env.AQUILLA_PG, 2, now))?.weeklyAllowanceUnits).toBeNull()
  })

  it('moves the tier with a legacy plan write so the old admin picker still works until T10', async () => {
    await org(3); await pg.exec(MIGRATION)
    await upsertOrgBilling(env.AQUILLA_PG, { orgId: 3, plan: 'enterprise', status: 'active' })
    expect(await tierOf(3)).toBe('enterprise')
    await upsertOrgBilling(env.AQUILLA_PG, { orgId: 3, plan: 'none', status: 'none' })
    expect(await tierOf(3)).toBe('free')
  })

  it('returns null only for an org that does not exist', async () => {
    expect(await resolveOrgPlan(env.AQUILLA_PG, 404, now)).toBeNull()
  })
})

describe('the ledger reads the plan, not billing_scope', () => {
  async function project(orgId: number) {
    await seedUser(1, 'alice')
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p', 'P', ?, 1)").bind(orgId).run()
    return { orgId, projectId: 'p', userId: 1, requestId: 'r1', rail: 'llm' as const, maxRawCostCents: 10 }
  }

  it('admits an org with no billing_scope as Free instead of failing usage accounting', async () => {
    const input = await project(await org(2, null))
    // Was: "Workspace usage requires an explicit supported entitlement" → 503.
    const admitted = await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
    expect(admitted.request).toMatchObject({ mode: 'metered', reserved_micro_units: 40 * MICRO_UNITS_PER_UNIT })
    expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 2, now)).toMatchObject({ percent: 10 })
  })

  it('records Enterprise usage as unmetered and never refuses it on allowance', async () => {
    const input = await project(await org(5))
    await pg.exec("INSERT INTO org_billing (org_id, tier) VALUES (5, 'enterprise')")
    // $5 raw is 5× the Free week; Enterprise is never refused on allowance.
    const big = await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 500 }, now)
    expect(big.request).toMatchObject({ mode: 'unmetered' })
    expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 5, now)).toBeNull()
    // When the contract ends, unmetered usage from earlier that week does not
    // eat the Team-sized grace allowance.
    await pg.exec(`UPDATE org_billing SET contract_ends_at = '${now.toISOString()}'`)
    const plan = (await resolveOrgPlan(env.AQUILLA_PG, 5, now))!
    expect((await readUsageTotals(env.AQUILLA_PG, 5, plan.period)).committed).toBe(0)
    expect((await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'r2' }, now)).request.mode).toBe('metered')
  })
})

describe('GET /api/v2/orgs/:id/plan', () => {
  it('tells any member the tier, and nobody else', async () => {
    await seedUser(1, 'alice'); await seedUser(2, 'mallory')
    await org(5)
    await pg.exec("INSERT INTO org_members (org_id, user_id, role_level) VALUES (5, 1, 100); INSERT INTO org_billing (org_id, tier) VALUES (5, 'enterprise')")
    const read = async (who: string) => app.request('/api/v2/orgs/5/plan', { headers: authHeader(await jwtFor(who)) }, env)
    const ok = await read('alice')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ orgId: 5, tier: 'enterprise', metered: false, contractEndsAt: null })
    expect((await read('mallory')).status).toBe(403)
  })
})
