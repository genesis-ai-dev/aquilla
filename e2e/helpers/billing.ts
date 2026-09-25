import { makePostgres } from '../../db/shim/postgres'
import { recordInitialWorkspaceEntitlement } from '../../auth-worker/src/lib/billing/workspace-entitlements'
import { stripeCatalogResponse, testStripeCatalog as manifest } from '../../auth-worker/src/__tests__/helpers/stripe-catalog'
import type { StripePriceInput } from '../../auth-worker/src/lib/billing/pricing-model'

/** Seed through the actual entitlement writer, only in the harness-owned database. */
function testBillingDb() {
  const url = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/aquilla_e2e(?:_s\d+)?$/.test(url.pathname)) {
    throw new Error('Billing fixtures require a local E2E database')
  }
  return makePostgres(url.toString(), 1)
}

export async function recordTestWorkspacePlan(orgId: number) {
  const db = testBillingDb()
  try {
    return await recordInitialWorkspaceEntitlement(db, {
      orgId, catalog: manifest,
      prices: manifest.bindings.map(b => stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput),
      offer: 'team_20x', interval: 'year', quantity: 1,
      subscriptionId: `sub_e2e_${orgId}`, customerId: `cus_e2e_${orgId}`,
      paidThrough: new Date(Date.now() + 86400000 * 365).toISOString(),
      activatedAt: new Date(Date.now() - 86400000).toISOString(),
    })
  } finally { await db.close() }
}

/** Browser coverage consumes persisted facts; signed-event production is covered
 * by billing-workspace-checkout.test.ts against real Postgres. */
export async function recordTestWorkspaceFailure(orgId: number) {
  const db = testBillingDb()
  try {
    const saved = await db.prepare(`UPDATE workspace_subscription_state
      SET payment_failed = true, revision = revision + 1 WHERE org_id = ? RETURNING org_id`)
      .bind(orgId).first()
    if (!saved) throw new Error('Billing state not seeded')
  } finally { await db.close() }
}
