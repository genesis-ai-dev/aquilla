import { env } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { seedUser } from '../../__tests__/helpers/db'
import { assignPriceCohort, recordPricingExposure, readPriceCohort, type PriceExperiment } from './price-cohorts'
const experiment: PriceExperiment = {
  key: 'individual-price-test-v1', enabled: true,
  variants: [{ key: 'baseline', priceVersion: 'baseline-v1', weight: 5000 },
    { key: 'higher', priceVersion: 'higher-v1', weight: 5000 }],
}
beforeEach(async () => {
  await seedUser(1, 'buyer')
  await env.AQUILLA_PG.prepare(`INSERT INTO organizations (id, name, owner_user_id)
    VALUES (1, 'Personal', 1), (2, 'Team', 1)`).run()
})
it('persists one assignment across concurrent requests and later weight changes', async () => {
  const db = env.AQUILLA_PG
  const [first, second] = await Promise.all([
    assignPriceCohort(db, 1, experiment, true),
    assignPriceCohort(db, 1, experiment, true),
  ])
  expect(first).toEqual(second)
  const changed = { ...experiment, variants: [{ key: 'different', priceVersion: 'new', weight: 10000 }] }
  expect(await assignPriceCohort(db, 1, changed, true)).toEqual(first)
  expect(await assignPriceCohort(db, 1, { ...experiment, enabled: false }, false)).toEqual(first)
  expect(first?.exposed_at).toBeNull()
  expect(await recordPricingExposure(db, 1, experiment.key, 'unassigned-price')).toBe(false)
  expect(await recordPricingExposure(db, 1, experiment.key, first!.price_version)).toBe(true)
  expect(await recordPricingExposure(db, 1, experiment.key, first!.price_version)).toBe(false)
  expect((await readPriceCohort(db, 1, experiment.key))?.exposed_at).not.toBeNull()
  expect(await readPriceCohort(db, 2, experiment.key)).toBeNull()
})
it('does not enroll existing/sponsored workspaces or activate a disabled test', async () => {
  expect(await assignPriceCohort(env.AQUILLA_PG, 1, experiment, false)).toBeNull()
  expect(await assignPriceCohort(env.AQUILLA_PG, 2, { ...experiment, enabled: false }, true)).toBeNull()
})
it('fails closed on invalid experiments instead of inventing an assignment', async () => {
  await expect(assignPriceCohort(env.AQUILLA_PG, 1, { ...experiment, variants: [] }, true)).rejects.toThrow()
  expect(await readPriceCohort(env.AQUILLA_PG, 1, experiment.key)).toBeNull()
})
