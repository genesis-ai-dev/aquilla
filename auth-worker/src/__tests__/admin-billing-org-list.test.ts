// The admin billing org list, read in batches.
// Why these tests matter:
// - The list used to read each org's usage and plan one org at a time, about
//   eight queries an org, and the Billing tab timed out on production. The fix
//   only holds if a page costs the same number of queries whatever its size.
// - Admins set plans from this list, so each row must say exactly what the
//   per-org reads (readWordSnapshot, resolveOrgPlan) say. A batched row that
//   drifts from them would show an admin numbers the meter does not use.
// - With hundreds of orgs an admin finds one by search, so search, the tier
//   filter and paging must reach every org.
import app from '../index'
import { env, pg } from './helpers/pg-test-env'
import { authHeader, jwtFor, seedUser } from './helpers/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOrgPlan, resolveOrgPlans } from '../../../db/shared/org-plan'
import { readWordSnapshot } from '../lib/billing/words'
import { readWordSnapshots } from '../lib/billing/word-snapshots'
import { readAdminBillingOrgs } from '../lib/billing/admin-org-list'
import { resolveFieldPlan } from '../lib/billing/plans'

const request = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init, env))
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  await seedUser(7, 'root')
  await seedUser(1, 'wendi')
  await seedUser(2, 'ana')
  await pg.exec(`INSERT INTO organizations (id, name, owner_user_id) VALUES
      (1, 'Alpha Free', 1), (2, 'Beta Field', 2), (3, 'Gamma Enterprise', 1), (4, 'Delta 100%_off', 2);
    INSERT INTO org_billing (org_id, plan, status, current_period_start, current_period_end, complimentary_words)
      VALUES (2, 'field', 'active', '${daysAgo(10)}T05:00:00Z', '${daysAgo(-20)}T05:00:00Z', 5000);
    INSERT INTO org_billing (org_id, tier, contract_ends_at) VALUES (3, 'enterprise', NULL);
    INSERT INTO org_settings (org_id, settings, version) VALUES
      (2, '{"billing":{"includedCredits":40}}', 1), (3, '{"billing":{"billedLanguageCount":3}}', 1);
    INSERT INTO projects (id, name, org_id, created_by, is_active) VALUES ('p1', 'p1', 1, 1, true);
    INSERT INTO lanes (id, project_id, role, name) VALUES ('l1', 'p1', 'target', 'Spanish'), ('l2', 'p1', 'target', 'French')`)
  // Usage on both sides of org 2's period start and of the trailing year.
  for (const [orgId, day, words] of [[1, 1, 300], [1, 400, 9_000], [2, 2, 700], [2, 30, 1_100], [3, 200, 50_000]] as const) {
    await pg.query(`INSERT INTO org_word_usage_daily (org_id, user_id, date_utc, rail, words) VALUES ($1, 1, $2, 'llm', $3)`,
      [orgId, daysAgo(day), words])
  }
})

async function admin() { return authHeader(await jwtFor('root')) }
const catalog = resolveFieldPlan(undefined, env)

describe('batched reads match the per-org reads', () => {
  it('every word snapshot equals readWordSnapshot for the same org', async () => {
    const batch = await readWordSnapshots(env.AQUILLA_PG, [1, 2, 3, 4], catalog)
    for (const id of [1, 2, 3, 4]) {
      expect(batch.get(id), `org ${id}`).toEqual(await readWordSnapshot(env.AQUILLA_PG, id, catalog))
    }
    // Sanity: the seed exercises period vs trailing year and the overrides.
    expect(batch.get(1)).toMatchObject({ wordsUsed: 300, trailingYearWords: 300, languageCount: 2 })
    expect(batch.get(2)).toMatchObject({ wordsUsed: 700, trailingYearWords: 1_800, includedCreditsOverride: 40 })
    expect(batch.get(3)).toMatchObject({ trailingYearWords: 50_000, languageCount: 3 })
  })

  it('every plan equals resolveOrgPlan, and a missing org is absent', async () => {
    const now = new Date()
    const batch = await resolveOrgPlans(env.AQUILLA_PG, [1, 2, 3, 4, 999], now)
    for (const id of [1, 2, 3, 4]) expect(batch.get(id), `org ${id}`).toEqual(await resolveOrgPlan(env.AQUILLA_PG, id, now))
    expect(batch.has(999)).toBe(false)
    // Enterprise with no end date is the unmetered plan.
    expect(batch.get(3)).toMatchObject({ tier: 'enterprise', weeklyAllowanceUnits: null, contractEndsAt: null })
  })

  it('a page costs the same number of queries for 1 org as for 4', async () => {
    const spy = vi.spyOn(env.AQUILLA_PG, 'prepare')
    await readAdminBillingOrgs(env.AQUILLA_PG, catalog, { limit: 1, offset: 0 })
    const one = spy.mock.calls.length
    spy.mockClear()
    await readAdminBillingOrgs(env.AQUILLA_PG, catalog, { limit: 50, offset: 0 })
    expect(spy.mock.calls.length).toBe(one)
    spy.mockRestore()
  })
})

describe('GET /admin/billing/orgs', () => {
  async function list(qs = '') {
    const res = await request(`/api/v2/admin/billing/orgs${qs}`, { headers: await admin() })
    expect(res.status).toBe(200)
    return (await res.json()) as { orgs: { orgId: number; tier: string; effectiveWeeklyAllowance: number | null }[]; total: number }
  }
  const ids = (r: { orgs: { orgId: number }[] }) => r.orgs.map(o => o.orgId)

  it('searches org name, owner username and exact id', async () => {
    expect(ids(await list('?q=gamma'))).toEqual([3])
    expect(ids(await list('?q=ana'))).toEqual([2, 4])
    expect(ids(await list('?q=4'))).toEqual([4])
    // LIKE wildcards in the search are literal text.
    expect(ids(await list('?q=100%25_'))).toEqual([4])
    expect(ids(await list('?q=_'))).toEqual([4])
  })

  it('filters by stored tier, mapping the legacy plan', async () => {
    expect(ids(await list('?tier=paid'))).toEqual([2, 3])
    expect(ids(await list('?tier=team'))).toEqual([2])
    expect(ids(await list('?tier=free'))).toEqual([1, 4])
  })

  it('sorts by this period\'s usage — the number each row shows — then by name', async () => {
    const res = await request('/api/v2/admin/billing/orgs?sort=usage', { headers: await admin() })
    const { orgs } = (await res.json()) as { orgs: { orgId: number; wordsUsed: number }[] }
    // Org 2's period started 10 days ago (its day-30 usage is outside it);
    // org 3's usage is older than the default window, so it ties at zero.
    expect(orgs.map(o => [o.orgId, o.wordsUsed])).toEqual([[2, 700], [1, 300], [4, 0], [3, 0]])
    expect((await request('/api/v2/admin/billing/orgs?sort=newest', { headers: await admin() })).status).toBe(400)
  })

  it('pages with a total that counts every match', async () => {
    const first = await list('?limit=2&offset=0')
    const second = await list('?limit=2&offset=2')
    expect(first.total).toBe(4)
    expect(second.total).toBe(4)
    expect([...ids(first), ...ids(second)]).toEqual([1, 2, 4, 3])
    expect((await request('/api/v2/admin/billing/orgs?limit=500', { headers: await admin() })).status).toBe(400)
  })

  it('returns one org in the list shape, and 404s an unknown one', async () => {
    const res = await request('/api/v2/admin/billing/orgs/3', { headers: await admin() })
    expect(res.status).toBe(200)
    const { org } = (await res.json()) as { org: { orgId: number; tier: string; effectiveWeeklyAllowance: number | null } }
    expect(org).toMatchObject({ orgId: 3, tier: 'enterprise', effectiveWeeklyAllowance: null })
    expect(org).toEqual((await list('?q=3')).orgs[0])
    expect((await request('/api/v2/admin/billing/orgs/999', { headers: await admin() })).status).toBe(404)
    expect((await request('/api/v2/admin/billing/orgs/3x', { headers: await admin() })).status).toBe(400)
  })

  it('403s a non-admin', async () => {
    const res = await request('/api/v2/admin/billing/orgs', { headers: authHeader(await jwtFor('wendi')) })
    expect(res.status).toBe(403)
  })
})
