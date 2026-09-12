import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { catalogSchema } from '../../lib/billing/catalog-schema'
// Node (Playwright) and Vitest share the same validated fixture.
export const testStripeCatalog = catalogSchema.parse(JSON.parse(readFileSync(
  new URL('../../../../config/pricing/stripe-sandbox.json', import.meta.url), 'utf8',
)))
const manifest = testStripeCatalog
const amounts: Record<string, number> = {
  pro: 2000, max_5x: 6000, max_20x: 12000, team: 60000, team_20x: 12000,
}
export function stripeCatalogResponse(path: string) {
  if (path === '/v1/account') return { id: manifest.accountId }
  const binding = manifest.bindings.find(b => path.endsWith(`/${b.priceId}`))!
  return {
    id: binding.priceId, product: binding.productId, active: true,
    livemode: false, type: 'recurring', billing_scheme: 'per_unit',
    currency: 'usd', unit_amount: amounts[binding.offer]! * (binding.interval === 'year' ? 10 : 1),
    recurring: { interval: binding.interval, interval_count: 1, usage_type: 'licensed' },
  }
}
