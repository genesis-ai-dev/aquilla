import { env, pg } from './helpers/pg-test-env'
import { afterEach, describe, expect, it } from 'vitest'
import app from '../index'
import { seedUser, jwtFor, authHeader } from './helpers/db'
import { readBillingWorkspace, readProjectBillingWorkspace } from '../lib/billing/workspace'
import { recordInitialWorkspaceEntitlement } from '../lib/billing/workspace-entitlements'
import { stripeCatalogResponse } from './helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'
import type { PriceCatalog, StripePriceInput } from '../lib/billing/pricing-model'

async function create(username: string, name?: string) {
  const response = await app.request(name ? '/api/v2/orgs' : '/api/v2/orgs/me', {
    method: name ? 'POST' : 'GET', headers: authHeader(await jwtFor(username)),
    ...(name ? { body: JSON.stringify({ name }) } : {}),
  }, env)
  expect(response.status).toBe(200)
  return (await response.json() as { id: number }).id
}
async function context(username: string, orgId: number) {
  return app.request(`/api/v2/orgs/${orgId}/billing/workspace`, {
    headers: authHeader(await jwtFor(username)),
  }, env)
}
function payment(orgId: number, offer: 'pro' | 'team' | 'team_20x' = 'pro') {
  return {
    orgId, catalog: manifest as PriceCatalog,
    prices: manifest.bindings.map(b => stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput),
    offer, interval: 'year' as const, quantity: 1,
    subscriptionId: `sub_${orgId}`, customerId: `cus_${orgId}`,
    activatedAt: '2026-09-09T10:00:00.000Z',
  }
}
const now = new Date('2026-09-10T10:00:00Z')
afterEach(async () => { await pg.exec('DROP TABLE IF EXISTS org_entitlements') })

describe('workspace creation → persisted billing eligibility', () => {
  it('distinguishes personal creation from a named team without trusting names', async () => {
    await seedUser(1, 'alice')
    const personal = await create('alice')
    const team = await create('alice', "alice's workspace")
    expect(await readBillingWorkspace(env.AQUILLA_PG, personal)).toMatchObject({
      scope: 'personal', eligibility: { reason: 'ready', offers: ['pro', 'max_5x', 'max_20x'] },
    })
    const response = await context('alice', team)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({
      scope: 'team', eligibility: { reason: 'ready', offers: ['team', 'team_20x'] },
      usagePercent: null, checkoutEnabled: false,
    })
  })
  it('creates one personal workspace under concurrent first access', async () => {
    await seedUser(1, 'alice')
    const ids = await Promise.all([create('alice'), create('alice')])
    expect(ids[0]).toBe(ids[1])
  })
  it('treats project-only guests as collaborators for personal eligibility', async () => {
    await seedUser(1, 'alice'); await seedUser(2, 'bob')
    const orgId = await create('alice')
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('guest-project', 'Project', ?, 1)").bind(orgId).run()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES ('guest-project', 2, 200)").run()
    expect(await readBillingWorkspace(env.AQUILLA_PG, orgId)).toMatchObject({
      eligibility: { reason: 'personal_collaboration_review', offers: [] },
    })
  })
  it('does not reclassify an older owned organization when /me returns it', async () => {
    await seedUser(1, 'alice')
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (50, 'Personal', 1)").run()
    expect(await create('alice')).toBe(50)
    expect(await readBillingWorkspace(env.AQUILLA_PG, 50)).toMatchObject({
      scope: null, eligibility: { reason: 'scope_unconfirmed', offers: [] },
    })
  })
  it('requires billing authority and does not expose another workspace', async () => {
    await seedUser(1, 'alice'); await seedUser(2, 'bob')
    const orgId = await create('alice', 'Team')
    expect((await context('bob', orgId)).status).toBe(403)
    await env.AQUILLA_PG.prepare('INSERT INTO org_members (org_id, user_id, role_level) VALUES (?, 2, 400)').bind(orgId).run()
    expect((await context('bob', orgId)).status).toBe(403)
  })
  it('blocks personal collaboration until reviewer rules are approved', async () => {
    await seedUser(1, 'alice'); await seedUser(2, 'bob')
    const orgId = await create('alice')
    await env.AQUILLA_PG.prepare('INSERT INTO org_members (org_id, user_id, role_level) VALUES (?, 2, 200)').bind(orgId).run()
    expect(await readBillingWorkspace(env.AQUILLA_PG, orgId)).toMatchObject({
      eligibility: { reason: 'personal_collaboration_review', offers: [] },
    })
  })
  it.each(['field', 'enterprise'])('preserves %s billing and covered access', async plan => {
    await seedUser(1, 'alice')
    const orgId = await create('alice', 'Team')
    await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, plan, status) VALUES (?, ?, 'active')").bind(orgId, plan).run()
    expect(await readBillingWorkspace(env.AQUILLA_PG, orgId)).toMatchObject({
      eligibility: { reason: 'existing_billing', offers: [] },
    })
    await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId, 'team'), now)).rejects.toThrow('not eligible')
  })
  it('respects independent partner entitlements when AQU-1212 is installed', async () => {
    await seedUser(1, 'alice')
    const orgId = await create('alice', 'Team')
    await pg.exec('CREATE TABLE org_entitlements (org_id bigint PRIMARY KEY, active boolean NOT NULL)')
    await env.AQUILLA_PG.prepare('INSERT INTO org_entitlements VALUES (?, true)').bind(orgId).run()
    expect(await readBillingWorkspace(env.AQUILLA_PG, orgId)).toMatchObject({
      eligibility: { reason: 'covered_access', offers: [] },
    })
    await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId, 'team'), now)).rejects.toThrow('not eligible')
  })
})

describe('approved offer → entitlement persistence → owning workspace', () => {
  it('persists annual Team capacity without exposing ledger values', async () => {
    await seedUser(1, 'alice')
    const orgId = await create('alice', 'Team')
    const saved = await recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId, 'team_20x'), now)
    expect(saved).toMatchObject({ offer: 'team_20x', scope: 'team', quantity: 1, billing_interval: 'year' })
    expect(saved.price_ids).toHaveLength(2)
    const body = await (await context('alice', orgId)).json()
    expect(body).toMatchObject({ entitlement: { offer: 'team_20x', entitlementVersion: '2026-09-weekly' }, checkoutEnabled: false })
    expect(JSON.stringify(body)).not.toMatch(/credits|stripe_|sub_|cus_|price_1/)
  })
  it('deduplicates concurrent activation and preserves the original anchor on redelivery', async () => {
    await seedUser(1, 'alice')
    const orgId = await create('alice')
    const input = payment(orgId)
    const results = await Promise.all([
      recordInitialWorkspaceEntitlement(env.AQUILLA_PG, input, now),
      recordInitialWorkspaceEntitlement(env.AQUILLA_PG, { ...input, activatedAt: now.toISOString() }, now),
    ])
    expect(results[0].usage_anchor).toBe(results[1].usage_anchor)
    const rows = await env.AQUILLA_PG.prepare('SELECT count(*) AS count FROM workspace_plan_entitlements').first<{ count: number }>()
    expect(rows?.count).toBe(1)
    const workspace = await readBillingWorkspace(env.AQUILLA_PG, orgId, new Date('2026-09-16T10:00:00Z'))
    expect(workspace?.entitlement?.usagePeriodStart).toBe('2026-09-16T10:00:00.000Z')
  })
  it('rejects wrong-scope purchases and unapproved entitlement changes', async () => {
    await seedUser(1, 'alice')
    const orgId = await create('alice', 'Team')
    await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId), now)).rejects.toThrow('not eligible')
    await recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId, 'team'), now)
    await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(orgId, 'team_20x'), now)).rejects.toThrow('change policy')
    expect((await readBillingWorkspace(env.AQUILLA_PG, orgId, now))?.entitlement?.offer).toBe('team')
  })
  it('rejects a subscription reused on another workspace without leaving a row', async () => {
    await seedUser(1, 'alice'); await seedUser(2, 'bob')
    const first = await create('alice')
    const second = await create('bob')
    await recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(first), now)
    await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, {
      ...payment(second), subscriptionId: payment(first).subscriptionId,
    }, now)).rejects.toThrow()
    expect((await readBillingWorkspace(env.AQUILLA_PG, second, now))?.entitlement).toBeNull()
  })
  it('rejects invalid prices, versions, quantities, and future anchors before persistence', async () => {
    await seedUser(1, 'alice')
    const orgId = await create('alice')
    const input = payment(orgId)
    for (const patch of [{ quantity: 2 }, { prices: [] },
      { activatedAt: '2030-01-01T00:00:00Z' },
      { catalog: { ...input.catalog, entitlementVersion: '2026-09' } }]) {
      await expect(recordInitialWorkspaceEntitlement(env.AQUILLA_PG, { ...input, ...patch }, now)).rejects.toThrow()
    }
    expect((await readBillingWorkspace(env.AQUILLA_PG, orgId, now))?.entitlement).toBeNull()
  })
  it('uses project ownership even when its creator has a personal subscription', async () => {
    await seedUser(1, 'alice')
    const personal = await create('alice')
    const team = await create('alice', 'Team')
    await recordInitialWorkspaceEntitlement(env.AQUILLA_PG, payment(personal), now)
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('team-project', 'Project', ?, 1), ('unowned', 'Old', NULL, 1)").bind(team).run()
    expect(await readProjectBillingWorkspace(env.AQUILLA_PG, 'team-project', now)).toMatchObject({ orgId: team, scope: 'team', entitlement: null })
    expect(await readProjectBillingWorkspace(env.AQUILLA_PG, 'unowned', now)).toBeNull()
  })
})
