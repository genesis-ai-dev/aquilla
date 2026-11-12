import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { catalogSchema } from '../../lib/billing/catalog-schema'
// Node (Playwright) and Vitest share the same validated fixture.
export const testStripeCatalog = catalogSchema.parse(JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../config/pricing/stripe-sandbox.json'), 'utf8',
)))
const manifest = testStripeCatalog
// AQU-2058: Team is $500/month or $5,000/year (two months free).
const amounts: Record<string, { month: number; year: number }> = {
  team: { month: 50000, year: 500000 },
}
export function stripeCatalogResponse(path: string, catalog = manifest) {
  if (path === '/v1/account') return { id: catalog.accountId }
  const binding = catalog.bindings.find(b => path.endsWith(`/${b.priceId}`))!
  return {
    id: binding.priceId, product: binding.productId, active: true,
    livemode: binding.live, type: 'recurring', billing_scheme: 'per_unit',
    currency: 'usd', unit_amount: amounts[binding.offer]![binding.interval],
    recurring: { interval: binding.interval, interval_count: 1, usage_type: 'licensed' },
  }
}
