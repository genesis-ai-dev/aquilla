// AQU-2068 (unified billing T11): the % meter's one read. Why these tests
// matter: every member sees this meter, so the route must give members a
// percentage and NOTHING a customer could read as money or credits (spec R7),
// must say "unmetered" for Enterprise instead of a fake 0%, and must never let a
// non-member read another org's usage.
import app from '../index'
import { env, pg } from './helpers/pg-test-env'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { describe, expect, it } from 'vitest'
import { reserveWorkspaceUsage } from '../lib/billing/workspace-usage'

async function seed(tier?: 'team' | 'enterprise') {
  await seedUser(1, 'alice'); await seedUser(2, 'mallory')
  await env.AQUILLA_PG.prepare(`INSERT INTO organizations (id, name, owner_user_id, billing_scope, created_at)
    VALUES (5, 'org-5', 1, 'team', '2026-09-01T00:00:00Z'::timestamptz)`).run()
  // A plain member (not an admin): the meter is for everyone in the org.
  await pg.exec('INSERT INTO org_members (org_id, user_id, role_level) VALUES (5, 1, 10)')
  if (tier) await pg.exec(`INSERT INTO org_billing (org_id, tier) VALUES (5, '${tier}')`)
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p', 'P', 5, 1)").run()
}
const read = async (who: string) => app.request('/api/v2/orgs/5/ai-meter', { headers: authHeader(await jwtFor(who)) }, env)

describe('GET /api/v2/orgs/:id/ai-meter', () => {
  it('gives a Free member the percent used and when it resets, with no amounts', async () => {
    await seed()
    // 10¢ of the $1 Free week.
    await reserveWorkspaceUsage(env.AQUILLA_PG,
      { orgId: 5, projectId: 'p', userId: 1, requestId: 'r1', rail: 'llm', maxRawCostCents: 10 })
    const res = await read('alice')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ orgId: 5, plan: 'free', mode: 'metered', percentUsed: 10 })
    expect(typeof body.resetsAt).toBe('string')
    // R7: the exact key set, so a later "helpful" field (units, cents,
    // allowance, credits) fails here instead of reaching a customer.
    expect(Object.keys(body).sort()).toEqual(['mode', 'orgId', 'percentUsed', 'plan', 'resetsAt'])
  })

  it('says unmetered for Enterprise instead of showing 0%', async () => {
    await seed('enterprise')
    expect(await (await read('alice')).json()).toEqual({ orgId: 5, plan: 'enterprise', mode: 'unmetered', percentUsed: null, resetsAt: null })
  })

  it('refuses non-members', async () => {
    await seed()
    expect((await read('mallory')).status).toBe(403)
  })
})
