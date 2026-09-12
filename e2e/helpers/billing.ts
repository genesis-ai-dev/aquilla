import { makePostgres } from '../../db/shim/postgres'
import { recordInitialWorkspaceEntitlement } from '../../auth-worker/src/lib/billing/workspace-entitlements'
import { stripeCatalogResponse, testStripeCatalog as manifest } from '../../auth-worker/src/__tests__/helpers/stripe-catalog'
import type { StripePriceInput } from '../../auth-worker/src/lib/billing/pricing-model'

/** Seed through the actual entitlement writer, only in the harness-owned database. */
export async function recordTestWorkspacePlan(orgId: number) {
  const url = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/aquilla_e2e(?:_s\d+)?$/.test(url.pathname)) {
    throw new Error('Billing fixtures require a local E2E database')
  }
  const db = makePostgres(url.toString(), 1)
  try {
    return await recordInitialWorkspaceEntitlement(db, {
      orgId, catalog: manifest,
      prices: manifest.bindings.map(b => stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput),
      offer: 'team_20x', interval: 'year', quantity: 1,
      subscriptionId: `sub_e2e_${orgId}`, customerId: `cus_e2e_${orgId}`,
      activatedAt: new Date(Date.now() - 86400000).toISOString(),
    })
  } finally { await db.close() }
}
