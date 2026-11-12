import app from '../index'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { env } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { MICRO_UNITS_PER_UNIT, quoteProviderCost, readProviderCostCents } from '../../../db/shared/billing-cost'
import { completedPayment, pinSmallAllowancePolicy } from './helpers/workspace-billing'
import { reserveWorkspaceUsage, settleWorkspaceUsage, releaseWorkspaceUsage, readUsageTotals, readWorkspaceUsageSummary } from '../lib/billing/workspace-usage'
import { readWorkspaceEntitlement } from '../lib/billing/workspace'
import { weeklyUsagePeriod } from '../lib/billing/pricing-model'

// Real review/Checkout → signed activation creates the entitlement consumed here.
afterEach(() => vi.unstubAllGlobals())
async function setup() {
  const paid = await completedPayment('team', 'month', undefined, 'personal')
  expect((await paid.send()).status).toBe(200)
  await pinSmallAllowancePolicy()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('usage-project', 'Usage', 1, 1)").run()
  const stored = (await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!
  const now = new Date(Date.parse(stored.usage_anchor) + 1000)
  const period = weeklyUsagePeriod(stored.usage_anchor, now.toISOString())
  const input = { orgId: 1, projectId: 'usage-project', userId: 1,
    requestId: 'request-one', rail: 'llm' as const, maxRawCostCents: 10 }
  return { input, now, period }
}
it('consumes provider-cost parser output through durable settlement and preserves rate snapshots', async () => {
  const { input, now, period } = await setup()
  const admitted = await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  expect(admitted.created).toBe(true)
  expect(admitted.request).toMatchObject({ multiplier: 4, rate_version: '2026-09-cost-v1', reserved_micro_units: 40 * MICRO_UNITS_PER_UNIT })
  const cents = readProviderCostCents({ usage: { cost: 0.0125 } })
  expect(await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, cents)).toBe(true)
  expect(await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, cents)).toBe(false)
  expect(await readUsageTotals(env.AQUILLA_PG, 1, period)).toEqual({ reserved: 0, settled: 5 * MICRO_UNITS_PER_UNIT, committed: 5 * MICRO_UNITS_PER_UNIT })
  expect((await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)).created).toBe(false)
  await expect(settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 2)).rejects.toThrow('conflict')
})
it('admits only one simultaneous request when both cannot fit', async () => {
  const { input, now, period } = await setup()
  // Team: 250 units. Two 160-unit requests cannot both fit.
  const big = { ...input, maxRawCostCents: 40 }
  const results = await Promise.allSettled([
    reserveWorkspaceUsage(env.AQUILLA_PG, big, now),
    reserveWorkspaceUsage(env.AQUILLA_PG, { ...big, requestId: 'request-two' }, now),
  ])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(160 * MICRO_UNITS_PER_UNIT)
})
it('deduplicates concurrent admission without authorizing another provider call', async () => {
  const { input, now, period } = await setup()
  const results = await Promise.all([reserveWorkspaceUsage(env.AQUILLA_PG, input, now), reserveWorkspaceUsage(env.AQUILLA_PG, input, now)])
  expect(results.map(r => r.created).sort()).toEqual([false, true])
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(40 * MICRO_UNITS_PER_UNIT)
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, rail: 'agent' }, now)).rejects.toThrow('identity conflict')
})
it('shares agent and speech usage and retains consumed usage through cap changes', async () => {
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, rail: 'agent', maxRawCostCents: 7.5 }, now)
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 7.5)
  // A failed renewal past the 7-day grace drops the cap to Free (25 units < 30 used).
  const { paid_through: paidThrough } = (await env.AQUILLA_PG.prepare(
    'SELECT paid_through::text FROM workspace_subscription_state WHERE org_id = 1').first<{ paid_through: string }>())!
  await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET payment_failed = true, paid_through = ?::timestamptz WHERE org_id = 1')
    .bind(new Date(now.getTime() - 8 * 86_400_000).toISOString()).run()
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'speech', rail: 'tts', maxRawCostCents: 1 }, now)).rejects.toThrow('exhausted')
  // Payment recovery restores Team; usage already consumed this week still counts.
  await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET payment_failed = false, paid_through = ?::timestamptz WHERE org_id = 1')
    .bind(paidThrough).run()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'speech', rail: 'tts', maxRawCostCents: 1 }, now)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(34 * MICRO_UNITS_PER_UNIT)
})
it('keeps Team admission during the past-due grace, then falls back to Free', async () => {
  const { input, now } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 7.5 }, now)
  // Renewal failed one day ago: Stripe is still retrying, so Team (250) still admits.
  await env.AQUILLA_PG.prepare('UPDATE workspace_subscription_state SET payment_failed = true, paid_through = ?::timestamptz WHERE org_id = 1')
    .bind(new Date(now.getTime() - 86_400_000).toISOString()).run()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'in-grace', maxRawCostCents: 1 }, now)
  // Seven days after the paid period, the same workspace is capped at Free (25 < 34 used).
  const afterGrace = new Date(now.getTime() + 6 * 86_400_000 + 1000)
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'after-grace', maxRawCostCents: 0.01 }, afterGrace))
    .rejects.toThrow('exhausted')
})
it('assigns the exact reset boundary to a new week without changing the old ledger', async () => {
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 60)
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'just-before' }, new Date(Date.parse(period.end) - 1))).rejects.toThrow('exhausted')
  const next = await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'at-reset' }, new Date(period.end))
  expect(Date.parse(next.request.period_start)).toBe(Date.parse(period.end))
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).settled).toBe(240 * MICRO_UNITS_PER_UNIT)
})
it('keeps unknown provider spend reserved, records overruns, and releases only unused work', async () => {
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  expect(() => readProviderCostCents({ usage: {} })).toThrow('unavailable')
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).reserved).toBe(40 * MICRO_UNITS_PER_UNIT)
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 70)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).settled).toBe(280 * MICRO_UNITS_PER_UNIT)
  await expect(releaseWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId)).rejects.toThrow('cannot be released')
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'after-overrun', maxRawCostCents: 0.1 }, now)).rejects.toThrow('exhausted')
})
it('releases an unused reservation idempotently and never resurrects its request ID', async () => {
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  expect(await releaseWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId)).toBe(true)
  expect(await releaseWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId)).toBe(false)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(0)
  expect((await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)).request.state).toBe('released')
  await expect(settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 1)).rejects.toThrow('released')
})
it('rejects another workspace project and rolls back failed settlement', async () => {
  const { input, now, period } = await setup()
  await env.AQUILLA_PG.exec("INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (2, 'Other workspace', 2, 'team'); INSERT INTO projects (id, name, org_id, created_by) VALUES ('other-project', 'Other', 2, 2)")
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, projectId: 'other-project' }, now)).rejects.toThrow('another workspace')
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, projectId: 'unknown' }, now)).rejects.toThrow('another workspace')
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  await env.AQUILLA_PG.exec("ALTER TABLE workspace_usage_requests ADD CONSTRAINT fail_settle CHECK (state <> 'settled')")
  try {
    await expect(settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 1)).rejects.toThrow()
    expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).reserved).toBe(40 * MICRO_UNITS_PER_UNIT)
  } finally {
    await env.AQUILLA_PG.exec('ALTER TABLE workspace_usage_requests DROP CONSTRAINT fail_settle')
  }
  expect(await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 1)).toBe(true)
})
it.each([NaN, Infinity, -1, Number.MAX_VALUE])('rejects invalid provider cost %s', value => {
  expect(() => quoteProviderCost(value, 'llm')).toThrow()
})
it('retains fractional units instead of rounding every tiny call to a whole unit', () => {
  expect(quoteProviderCost(0.001, 'llm').microUnits).toBe(4000)
  expect(readProviderCostCents({ usage: { cost: 0 } })).toBe(0)
})

it('applies the same multiplier to agent, chat, and speech', () => {
  expect(['llm', 'agent', 'tts'].map(rail => quoteProviderCost(2, rail as 'llm' | 'agent' | 'tts').microUnits)).toEqual([8_000_000, 8_000_000, 8_000_000])
})

it('anchors explicit Free workspaces to creation and preserves legacy organizations', async () => {
  const { input, now } = await setup()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_subscription_state WHERE org_id = 1').run()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_plan_entitlements WHERE org_id = 1').run()
  const createdAt = new Date(now.getTime() - 10_000).toISOString()
  await env.AQUILLA_PG.prepare('UPDATE organizations SET created_at = ?::timestamptz WHERE id = 1').bind(createdAt).run()
  const admitted = await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 6.25 }, now)
  expect(Date.parse(admitted.request.period_start)).toBe(Date.parse(createdAt))
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'free-extra', maxRawCostCents: 0.01 }, now)).rejects.toThrow('exhausted')
  // AQU-2059: an unconfirmed billing_scope no longer refuses usage accounting
  // (that was a 503 on every AI route). The org is Free like any other, so it
  // is refused only because this week's Free allowance is spent.
  await env.AQUILLA_PG.prepare('UPDATE organizations SET billing_scope = NULL WHERE id = 1').run()
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'legacy' }, now)).rejects.toThrow('exhausted')
})
it('replays the real migration without losing usage or accepting an invalid accounting state', async () => {
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  const migration = readFileSync(new URL('../../../db/postgres/migrations/0097_workspace_usage_requests.sql', import.meta.url), 'utf8')
  await env.AQUILLA_PG.exec(migration)
  await env.AQUILLA_PG.exec(migration)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).reserved).toBe(40 * MICRO_UNITS_PER_UNIT)
  await expect(env.AQUILLA_PG.exec("UPDATE workspace_usage_requests SET multiplier = 5")).rejects.toThrow()
  await expect(env.AQUILLA_PG.exec("UPDATE workspace_usage_requests SET state = 'settled'")).rejects.toThrow()
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).reserved).toBe(40 * MICRO_UNITS_PER_UNIT)
})

it('lets a bounded request finish up to 5% over the week but starts nothing at 100%', async () => {
  // Team: 250 units = 62.5 raw cents. Reserving 60 cents leaves the week at 96%.
  const { input, now, period } = await setup()
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 60 }, now)
  // 7.5 cents would end at 108%: refused. 3 cents ends at 100.8%: allowed.
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'too-far', maxRawCostCents: 7.5 }, now)).rejects.toThrow('exhausted')
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'last-step', maxRawCostCents: 3 }, now)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(252 * MICRO_UNITS_PER_UNIT)
  // Past 100% nothing new starts, however small.
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'tiny', maxRawCostCents: 0.0001 }, now)).rejects.toThrow('exhausted')
  // Settling below the bound reopens admission; the ledger keeps the true total.
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, 'last-step', 0.1)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(240.4 * MICRO_UNITS_PER_UNIT)
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'reopened', maxRawCostCents: 0.5 }, now)
})

it('reports the same allowance and period admission uses, capped at 100 for display', async () => {
  const { input, now, period } = await setup()
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toEqual({ percent: 0, resetsAt: period.end })
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 60 }, now)
  // 240 of 250 units reserved: 96%. A settled overrun shows 100%, never more.
  expect((await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now))?.percent).toBe(96)
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 65)
  expect((await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now))?.percent).toBe(100)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).settled).toBe(260 * MICRO_UNITS_PER_UNIT)
  // AQU-2059: an unconfirmed workspace without Stripe is Free, so it has a
  // measured percentage on its own creation-anchored week. Only Enterprise
  // (unmetered) reports null.
  await env.AQUILLA_PG.prepare('UPDATE organizations SET billing_scope = NULL, created_at = ?::timestamptz WHERE id = 1')
    .bind(now.toISOString()).run()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_plan_entitlements WHERE org_id = 1').run()
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 0 })
  await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, tier) VALUES (1, 'enterprise')").run()
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toBeNull()
})

it('consumes an audited partner grant through the actual usage ledger without resetting spent capacity', async () => {
  const { input, now, period } = await setup()
  await seedUser(7, 'root')
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, maxRawCostCents: 5 }, now)
  await settleWorkspaceUsage(env.AQUILLA_PG, 1, input.requestId, 5)
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_subscription_state WHERE org_id = 1').run()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_plan_entitlements WHERE org_id = 1').run()
  await env.AQUILLA_PG.prepare("UPDATE workspace_checkout_attempts SET resolved_at = now(), resolution = 'expired' WHERE org_id = 1").run()
  // Keep the exact existing period while converting this fixture to negotiated access.
  await env.AQUILLA_PG.prepare('UPDATE organizations SET created_at = ?::timestamptz, billing_scope = NULL WHERE id = 1')
    .bind(period.start).run()
  const grant = (allowance: number | null) => app.request('/api/v2/admin/billing/org/1/weekly-allowance', {
    method: 'PATCH', headers: authHeader(jwtForSync), body: JSON.stringify({ allowance, reason: 'Partner allocation' }),
  }, env)
  const jwtForSync = await jwtFor('root')
  expect((await grant(100)).status).toBe(200)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 20, resetsAt: period.end })
  await reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'partner-request' }, now)
  expect((await readUsageTotals(env.AQUILLA_PG, 1, period)).committed).toBe(60 * MICRO_UNITS_PER_UNIT)
  expect((await grant(0)).status).toBe(200)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 100 })
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'zero' }, now)).rejects.toThrow('exhausted')
  expect(await env.AQUILLA_PG.prepare("SELECT action FROM admin_audit_log WHERE action = 'billing.weekly_allowance.update' LIMIT 1").first()).toEqual({ action: 'billing.weekly_allowance.update' })
  const denied = await app.request('/api/v2/admin/billing/org/1/weekly-allowance', {
    method: 'PATCH', headers: authHeader(await jwtFor('alice')),
    body: JSON.stringify({ allowance: 999, reason: 'Unauthorized' }),
  }, env)
  expect(denied.status).toBe(403)
  // Clearing the grant returns the org to its plan default (Free), whose
  // allowance this week's usage already exceeds; it is not left without a plan.
  expect((await grant(null)).status).toBe(200)
  await expect(reserveWorkspaceUsage(env.AQUILLA_PG, { ...input, requestId: 'cleared' }, now)).rejects.toThrow('exhausted')
})

it('uses an admin Free allowance change in both admission and displayed percentage', async () => {
  const { input, now } = await setup()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_subscription_state WHERE org_id = 1').run()
  await env.AQUILLA_PG.prepare('DELETE FROM workspace_plan_entitlements WHERE org_id = 1').run()
  await env.AQUILLA_PG.prepare('UPDATE organizations SET created_at = ?::timestamptz WHERE id = 1').bind(now.toISOString()).run()
  await seedUser(7, 'root')
  const response = await app.request('/api/v2/admin/billing/plans', {
    method: 'PATCH', headers: authHeader(await jwtFor('root')),
    // $0.25 raw = 100 units; a 10-cent raw request reserves 40 units.
    body: JSON.stringify({ freeWeeklyRawUsd: 0.25, ifMatchVersion: 1 }),
  }, env)
  expect(response.status).toBe(200)
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 40 })
})

// AQU-2056: Team is 24× Free in raw dollars. A Free change must move Team too,
// otherwise Team drifts from its "at most 25% of revenue" sizing; a per-org admin
// grant still wins over both so negotiated partners keep their number.
it('derives Team from the Free raw-dollar cap and lets a per-org grant override it', async () => {
  const paid = await completedPayment('team', 'month')
  expect((await paid.send()).status).toBe(200)
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('usage-project', 'Usage', 1, 1)").run()
  const stored = (await readWorkspaceEntitlement(env.AQUILLA_PG, 1))!
  const now = new Date(Date.parse(stored.usage_anchor) + 1000)
  const input = { orgId: 1, projectId: 'usage-project', userId: 1,
    requestId: 'team-one', rail: 'llm' as const, maxRawCostCents: 24 }
  await seedUser(7, 'root')
  const root = authHeader(await jwtFor('root'))
  // Default: Team = 24 × $1 = $24 raw. 24 raw cents is 1%.
  await reserveWorkspaceUsage(env.AQUILLA_PG, input, now)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 1 })
  // Halving Free halves Team ($12 raw): the same spend is now 2%.
  expect((await app.request('/api/v2/admin/billing/plans', {
    method: 'PATCH', headers: root, body: JSON.stringify({ freeWeeklyRawUsd: 0.5, ifMatchVersion: 0 }),
  }, env)).status).toBe(200)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 2 })
  // A per-org grant (units) beats the derived Team cap: 96 units used of 192 = 50%.
  expect((await app.request('/api/v2/admin/billing/org/1/weekly-allowance', {
    method: 'PATCH', headers: root, body: JSON.stringify({ allowance: 192, reason: 'Partner allocation' }),
  }, env)).status).toBe(200)
  expect(await readWorkspaceUsageSummary(env.AQUILLA_PG, 1, now)).toMatchObject({ percent: 50 })
  const plans = await (await app.request('/api/v2/admin/billing/plans', { headers: root }, env)).json()
  expect(plans).toMatchObject({ plan: { freeWeeklyRawUsd: 0.5, teamMultipleOfFree: 24, teamWeeklyRawUsd: 12,
    freeWeeklyUnits: 200, teamWeeklyUnits: 4800 } })
})
