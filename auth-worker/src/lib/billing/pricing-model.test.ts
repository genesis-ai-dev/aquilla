import { describe, expect, it } from 'vitest'
import {
  weeklyAllowance, weeklyUsagePeriod, resolveApprovedPrice,
  type ApprovedPriceBinding, type Offer, type StripePriceInput,
} from './pricing-model'
const binding: ApprovedPriceBinding = {
  priceId: 'price_team_year', productId: 'prod_team', offer: 'team',
  interval: 'year', currency: 'usd', live: false, maxQuantity: 1,
}
const price: StripePriceInput = {
  id: binding.priceId, product: binding.productId, active: true,
  livemode: false, type: 'recurring', billing_scheme: 'per_unit',
  currency: 'usd', unit_amount: 600000,
  recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' },
}
describe('new pricing contract', () => {
  it.each<[Offer, number, number]>([
    ['free', 1, 25], ['pro', 1, 50], ['max_5x', 1, 250],
    ['max_20x', 1, 1000], ['max_20x', 2, 2000], ['team', 1, 250],
    ['team_20x', 1, 1000], ['team_20x', 2, 2000],
  ])('%s × %i replaces rather than adds base capacity', (offer, qty, credits) => {
    expect(weeklyAllowance(offer, qty)).toBe(credits)
  })
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid quantity %s', quantity => {
      expect(() => weeklyAllowance('max_20x', quantity)).toThrow()
    },
  )
  it('does not let more capacity unlock team permissions', () => {
    const max = { ...binding, offer: 'max_20x' as const, maxQuantity: 4 }
    expect(resolveApprovedPrice([max], price, 2)).toMatchObject({
      scope: 'personal', allowanceCredits: 2000, quantity: 2,
    })
    expect(() => resolveApprovedPrice([binding], price, 2)).toThrow()
    expect(() => resolveApprovedPrice([max], price, 5)).toThrow()
  })
  it('gives annual payment weekly capacity and Stripe-sourced amounts', () => {
    expect(resolveApprovedPrice([binding], price, 1)).toMatchObject({
      allowanceCredits: 250, usageInterval: 'week', totalAmount: 600000,
      monthlyEquivalent: 50000,
    })
  })
  it('uses exact seven-day boundaries across leap days and billing renewals', () => {
    const anchor = '2024-02-26T23:45:10Z'
    expect(weeklyUsagePeriod(anchor, '2024-03-01T00:00:00Z')).toEqual({
      start: '2024-02-26T23:45:10.000Z', end: '2024-03-04T23:45:10.000Z',
    })
    expect(weeklyUsagePeriod(anchor, '2024-03-04T23:45:09Z')).toEqual({
      start: '2024-02-26T23:45:10.000Z', end: '2024-03-04T23:45:10.000Z',
    })
    expect(weeklyUsagePeriod(anchor, '2024-03-04T23:45:10Z')).toEqual({
      start: '2024-03-04T23:45:10.000Z', end: '2024-03-11T23:45:10.000Z',
    })
    // Inactivity does not move the original anchor or grant an annual pool.
    expect(weeklyUsagePeriod(anchor, '2025-02-24T23:45:10Z')).toEqual({
      start: '2025-02-24T23:45:10.000Z', end: '2025-03-03T23:45:10.000Z',
    })
  })
  it('rejects missing anchors instead of resetting credits', () => {
    expect(() => weeklyUsagePeriod('', '2026-09-09')).toThrow()
    expect(() => weeklyUsagePeriod('2026-09-10', '2026-09-09')).toThrow()
  })
  it('rejects unknown, ambiguous, inactive and mismatched prices', () => {
    expect(() => resolveApprovedPrice([], price, 1)).toThrow()
    expect(() => resolveApprovedPrice([binding, binding], price, 1)).toThrow()
    for (const patch of [
      { active: false }, { livemode: true }, { currency: 'cad' },
      { product: 'prod_other' }, { unit_amount: null }, { unit_amount: -1 },
      { billing_scheme: 'tiered' }, { transform_quantity: { divide_by: 2 } },
      { recurring: { interval: 'week', interval_count: 4, usage_type: 'licensed' } },
    ]) expect(() => resolveApprovedPrice([binding], { ...price, ...patch }, 1)).toThrow()
  })
})

it('retains spent usage through immediate upgrades, downgrades, and Free fallback', async () => {
  const { remainingWeeklyAllowance } = await import('./pricing-model')
  const { resolveWorkspaceAccess } = await import('../../../../db/shared/workspace-access')
  const now = new Date('2026-09-12T12:00:00Z')
  const paidThrough = '2026-10-01T12:00:00Z'
  const access = resolveWorkspaceAccess({ offer: 'max_20x', paymentFailed: true,
    paidThrough, cancelAtPeriodEnd: false }, now)
  expect(remainingWeeklyAllowance(access.offer, 30)).toBe(0)
  expect(remainingWeeklyAllowance(access.offer, 10)).toBe(15)
  expect(remainingWeeklyAllowance('pro', 30)).toBe(20)
  expect(remainingWeeklyAllowance('max_5x', 30)).toBe(220)
  expect(remainingWeeklyAllowance('pro', 200)).toBe(0)
  expect(() => remainingWeeklyAllowance('pro', -1)).toThrow()
  expect(() => remainingWeeklyAllowance('pro', NaN)).toThrow()
})
