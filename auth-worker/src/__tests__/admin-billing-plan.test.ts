// AQU-2067 (unified billing T10): the platform-admin billing portal.
// Why these tests matter:
// - The Free cap is the one number every metered allowance derives from. A
//   save must change what the meter enforces at once, and Team must move with
//   it, or an admin can quietly push Team past 25% of its revenue (spec Q7).
// - Enterprise is the only plan with no meter. An end date must hand the org a
//   Team-sized grace and then Free (spec Q5), not keep it unmetered forever.
// - The would-block report is the evidence for flipping shadow → enforce
//   (spec §5.4). Miscounted or misbucketed rows mean enforcing on bad data.
// - Plans and allowances are money: only platform admins may touch them.
import app from '../index'
import { env, pg } from './helpers/pg-test-env'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveOrgPlan } from '../../../db/shared/org-plan'
import { weeklyUsagePeriod } from '../../../db/shared/allowance-policy'
import { summarizeWouldBlock, teamCostCheck, type WouldBlockRow } from '../lib/billing/admin-plan'

const DAY = 24 * 60 * 60 * 1000
const CREATED = '2026-01-01T00:00:00Z'
const request = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init, env))

beforeEach(async () => {
  await seedUser(7, 'root')
  await seedUser(1, 'wendi')
  await seedUser(2, 'ana')
  await pg.exec(`INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES
      (1, 'Free Org', 1, '${CREATED}'), (2, 'Team Org', 1, '${CREATED}'), (3, 'Ent Org', 1, '${CREATED}');
    INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1);
    INSERT INTO org_billing (org_id, tier) VALUES (2, 'team')`)
})

async function admin() { return authHeader(await jwtFor('root')) }
async function setPlan(orgId: number, body: object) {
  return request(`/api/v2/admin/billing/org/${orgId}/plan`, {
    method: 'PATCH', headers: await admin(), body: JSON.stringify({ reason: 'test', ...body }),
  })
}
async function orgRow(orgId: number) {
  const res = await request('/api/v2/admin/billing/orgs', { headers: await admin() })
  const { orgs } = (await res.json()) as { orgs: { orgId: number; tier: string; resolvedTier: string; planSource: string;
    contractEndsAt: string | null; graceEndsAt: string | null; effectiveWeeklyAllowance: number | null }[] }
  return orgs.find(o => o.orgId === orgId)!
}

describe('global Free cap', () => {
  it('a Free change takes effect at once, and Team scales with it', async () => {
    const before = await request('/api/v2/admin/billing/plans', { headers: await admin() })
    const { version, plan } = (await before.json()) as { version: number; plan: { teamCost: { teamWeeklyRawUsd: number; exceedsMaxShare: boolean } } }
    // Default: $1 Free, Team 24× = $24/week, inside 25% of $5,000/52.
    expect(plan.teamCost).toMatchObject({ teamWeeklyRawUsd: 24, exceedsMaxShare: false })
    expect((await resolveOrgPlan(env.AQUILLA_PG, 1))!.weeklyAllowanceUnits).toBe(400)
    expect((await resolveOrgPlan(env.AQUILLA_PG, 2))!.weeklyAllowanceUnits).toBe(9_600)

    const patch = await request('/api/v2/admin/billing/plans', {
      method: 'PATCH', headers: await admin(), body: JSON.stringify({ freeWeeklyRawUsd: 2, ifMatchVersion: version }),
    })
    expect(patch.status).toBe(200)
    const saved = (await patch.json()) as { plan: { teamWeeklyRawUsd: number; teamCost: { exceedsMaxShare: boolean } } }
    // Team at 100% = $48/week ≈ 50% of revenue: the admin must be warned.
    expect(saved.plan.teamWeeklyRawUsd).toBe(48)
    expect(saved.plan.teamCost.exceedsMaxShare).toBe(true)
    // No cache, no deploy: the next admission reads the new cap.
    expect((await resolveOrgPlan(env.AQUILLA_PG, 1))!.weeklyAllowanceUnits).toBe(800)
    expect((await resolveOrgPlan(env.AQUILLA_PG, 2))!.weeklyAllowanceUnits).toBe(19_200)
  })

  it('warns exactly when Team passes 25% of weekly annual revenue', () => {
    // 25% × $5,000/52 ≈ $24.04: 24× a $1 Free fits, 24× $1.01 does not.
    expect(teamCostCheck({ freeWeeklyRawUsd: 1, teamMultipleOfFree: 24 }).exceedsMaxShare).toBe(false)
    expect(teamCostCheck({ freeWeeklyRawUsd: 1.01, teamMultipleOfFree: 24 }).exceedsMaxShare).toBe(true)
  })

  it('stores a per-org allowance given in raw dollars as meter units', async () => {
    const res = await request('/api/v2/admin/billing/org/1/weekly-allowance', {
      method: 'PATCH', headers: await admin(), body: JSON.stringify({ allowanceRawUsd: 2.5, reason: 'pilot' }),
    })
    expect(res.status).toBe(200)
    // The override beats the Free default, and uses the one $ → unit conversion.
    expect((await resolveOrgPlan(env.AQUILLA_PG, 1))!.weeklyAllowanceUnits).toBe(1_000)
    const both = await request('/api/v2/admin/billing/org/1/weekly-allowance', {
      method: 'PATCH', headers: await admin(), body: JSON.stringify({ allowance: 5, allowanceRawUsd: 1, reason: 'x' }),
    })
    expect(both.status).toBe(400)
  })
})

describe('per-org plan', () => {
  it('Enterprise with a future end date is unmetered', async () => {
    const ends = new Date(Date.now() + 30 * DAY).toISOString()
    expect((await setPlan(3, { tier: 'enterprise', contractEndsAt: ends })).status).toBe(200)
    const row = await orgRow(3)
    expect(row).toMatchObject({ tier: 'enterprise', resolvedTier: 'enterprise', contractEndsAt: ends, effectiveWeeklyAllowance: null })
  })

  it('Enterprise whose contract ended 5 days ago is in a Team-sized grace the admin can see', async () => {
    const ends = new Date(Date.now() - 5 * DAY)
    await setPlan(3, { tier: 'enterprise', contractEndsAt: ends.toISOString() })
    const row = await orgRow(3)
    expect(row).toMatchObject({ tier: 'enterprise', resolvedTier: 'team', planSource: 'contract_grace', effectiveWeeklyAllowance: 9_600 })
    expect(row.graceEndsAt).toBe(new Date(ends.getTime() + 14 * DAY).toISOString())
  })

  it('Enterprise whose grace has run out is Free', async () => {
    await setPlan(3, { tier: 'enterprise', contractEndsAt: new Date(Date.now() - 20 * DAY).toISOString() })
    expect(await orgRow(3)).toMatchObject({ tier: 'enterprise', resolvedTier: 'free', effectiveWeeklyAllowance: 400 })
  })

  it('leaving Enterprise clears the contract end, and a non-Enterprise end date is refused', async () => {
    await setPlan(3, { tier: 'enterprise', contractEndsAt: new Date(Date.now() + DAY).toISOString() })
    expect((await setPlan(3, { tier: 'free', contractEndsAt: new Date().toISOString() })).status).toBe(400)
    expect((await setPlan(3, { tier: 'free' })).status).toBe(200)
    expect(await orgRow(3)).toMatchObject({ tier: 'free', contractEndsAt: null, resolvedTier: 'free' })
    const audit = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action = 'billing.org_plan.update'`)
    expect(audit.rows[0]!.n).toBe(2)
  })

  it('404s an unknown org', async () => {
    expect((await setPlan(999, { tier: 'team' })).status).toBe(404)
  })
})

describe('would-block report', () => {
  let n = 0
  async function usage(orgId: number, userId: number | null, rail: string, weeksAgo: number, decision = 'would_block', rawMicroCents = 50_000_000) {
    const cur = weeklyUsagePeriod(CREATED, new Date().toISOString())
    const start = new Date(Date.parse(cur.start) - weeksAgo * 7 * DAY)
    const end = new Date(start.getTime() + 7 * DAY)
    const created = new Date(start.getTime() + 60_000)
    await pg.query(`INSERT INTO workspace_usage_requests (org_id, request_id, user_id, rail, rate_version, multiplier,
        period_start, period_end, reserved_micro_units, state, raw_micro_cents, settled_micro_units, resolved_at, created_at, decision)
      VALUES ($1, $2, $3, $4, '2026-09-cost-v1', 4, $5, $6, $7, 'settled', $8, $7, $9, $9, $10)`,
    [orgId, `r${++n}`, userId, rail, start.toISOString(), end.toISOString(), rawMicroCents * 4, rawMicroCents, created.toISOString(), decision])
  }

  it('counts would-blocks per org, user and rail in the current and previous period only', async () => {
    await usage(1, 1, 'llm', 0); await usage(1, 1, 'llm', 0); await usage(1, 2, 'agent', 0)
    await usage(1, null, 'llm', 1)            // background work, previous period
    await usage(1, 1, 'llm', 0, 'allow')      // allowed: not in the report
    await usage(1, 1, 'llm', 2)               // two periods ago: out of the window
    await usage(2, 2, 'tts', 1)               // Team org, previous period only

    const res = await request('/api/v2/admin/billing/would-block', { headers: await admin() })
    expect(res.status).toBe(200)
    const { orgs } = (await res.json()) as { orgs: ReturnType<typeof summarizeWouldBlock> }
    expect(orgs.map(o => o.orgId)).toEqual([1, 2])   // most current would-blocks first
    const free = orgs[0]!
    expect(free.tier).toBe('free')
    expect(free.current).toMatchObject({ requests: 3, byRail: { llm: 2, agent: 1 } })
    expect(free.current.rawUsd).toBeCloseTo(1.5)    // 3 × 50,000,000 µ¢ = $1.50
    expect(free.current.users).toEqual([
      { userId: 1, username: 'wendi', requests: 2, rails: ['llm'] },
      { userId: 2, username: 'ana', requests: 1, rails: ['agent'] },
    ])
    expect(free.previous).toMatchObject({ requests: 1, users: [{ userId: null, requests: 1 }] })
    // Settled metered usage this period: 4 rows × $0.50 raw = $2 against a $1 cap.
    expect(free.pctUsed).toBeCloseTo(2)
    expect(orgs[1]).toMatchObject({ tier: 'team', current: { requests: 0 }, previous: { requests: 1, byRail: { tts: 1 } } })
  })

  it('folds rows for the same user across rails without double-counting', () => {
    const base = { org_id: 9, org_name: 'x', user_id: 4, username: 'u', is_current: true, raw_micro_cents: 0, last_at: '2026-10-20T00:00:00Z' }
    const rows: WouldBlockRow[] = [
      { ...base, rail: 'llm', requests: 3 }, { ...base, rail: 'agent', requests: 2 },
      { ...base, rail: 'llm', requests: 1, is_current: false, last_at: '2026-10-12T00:00:00Z' },
    ]
    const [org] = summarizeWouldBlock(rows)
    expect(org!.current.users).toEqual([{ userId: 4, username: 'u', requests: 5, rails: ['llm', 'agent'] }])
    expect(org!.previous.requests).toBe(1)
    expect(org!.lastAt).toBe('2026-10-20T00:00:00Z')
  })
})

describe('permissions', () => {
  it('403s a non-admin on every portal route', async () => {
    const wendi = authHeader(await jwtFor('wendi'))
    const calls: [string, RequestInit][] = [
      ['/api/v2/admin/billing/would-block', { headers: wendi }],
      ['/api/v2/admin/billing/org/1/plan', { method: 'PATCH', headers: wendi, body: JSON.stringify({ tier: 'enterprise', reason: 'x' }) }],
      ['/api/v2/admin/billing/org/1/weekly-allowance', { method: 'PATCH', headers: wendi, body: JSON.stringify({ allowanceRawUsd: 100, reason: 'x' }) }],
    ]
    for (const [path, init] of calls) expect((await request(path, init)).status, path).toBe(403)
    // Wendi owns org 1 and still cannot make it Enterprise.
    expect((await resolveOrgPlan(env.AQUILLA_PG, 1))!.tier).toBe('free')
  })
})
