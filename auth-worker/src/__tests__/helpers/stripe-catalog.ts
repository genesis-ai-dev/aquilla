import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { catalogSchema } from '../../lib/billing/catalog-schema'
// Node (Playwright) and Vitest share the same validated fixture.
export const testStripeCatalog = catalogSchema.parse(JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../config/pricing/stripe-sandbox.json'), 'utf8',
)))
const manifest = testStripeCatalog
const amounts: Record<string, number> = {
  pro: 2000, max_5x: 6000, max_20x: 12000, team: 60000, team_20x: 12000,
}
export function stripeCatalogResponse(path: string, catalog = manifest) {
  if (path === '/v1/account') return { id: catalog.accountId }
  const binding = catalog.bindings.find(b => path.endsWith(`/${b.priceId}`))!
  return {
    id: binding.priceId, product: binding.productId, active: true,
    livemode: false, type: 'recurring', billing_scheme: 'per_unit',
    currency: 'usd', unit_amount: (binding.offer === 'team_20x' && catalog.checkoutLayout === 'single_item'
      ? 72000 : amounts[binding.offer]!) * (binding.interval === 'year' ? 10 : 1),
    recurring: { interval: binding.interval, interval_count: 1, usage_type: 'licensed' },
  }
}
