import { describe, expect, it } from 'vitest'
import {
  monthlyAllowance, monthlyUsagePeriod, resolveApprovedPrice,
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
    ['free', 1, 100], ['pro', 1, 200], ['max_5x', 1, 1000],
    ['max_20x', 1, 4000], ['max_20x', 2, 8000], ['team', 1, 1000],
    ['team_20x', 1, 4000], ['team_20x', 2, 8000],
  ])('%s × %i replaces rather than adds base capacity', (offer, qty, credits) => {
    expect(monthlyAllowance(offer, qty)).toBe(credits)
  })
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid quantity %s', quantity => {
      expect(() => monthlyAllowance('max_20x', quantity)).toThrow()
    },
  )
  it('does not let more capacity unlock team permissions', () => {
    const max = { ...binding, offer: 'max_20x' as const, maxQuantity: 4 }
    expect(resolveApprovedPrice([max], price, 2)).toMatchObject({
      scope: 'personal', allowanceCredits: 8000, quantity: 2,
    })
    expect(() => resolveApprovedPrice([binding], price, 2)).toThrow()
    expect(() => resolveApprovedPrice([max], price, 5)).toThrow()
  })
  it('gives annual payment a monthly allowance and Stripe-sourced amounts', () => {
    expect(resolveApprovedPrice([binding], price, 1)).toMatchObject({
      allowanceCredits: 1000, totalAmount: 600000, monthlyEquivalent: 50000,
    })
    expect(monthlyUsagePeriod('2026-01-31T12:00:00Z', '2026-03-10T00:00:00Z'))
      .toEqual({ start: '2026-02-28T12:00:00.000Z', end: '2026-03-31T12:00:00.000Z' })
  })
  it('preserves the anchor across short months, exact boundaries and leap years', () => {
    const anchor = '2024-01-31T23:45:10Z'
    expect(monthlyUsagePeriod(anchor, '2024-02-29T23:45:09Z'))
      .toEqual({ start: '2024-01-31T23:45:10.000Z', end: '2024-02-29T23:45:10.000Z' })
    expect(monthlyUsagePeriod(anchor, '2024-02-29T23:45:10Z'))
      .toEqual({ start: '2024-02-29T23:45:10.000Z', end: '2024-03-31T23:45:10.000Z' })
    expect(monthlyUsagePeriod(anchor, '2025-03-31T23:45:10Z'))
      .toEqual({ start: '2025-03-31T23:45:10.000Z', end: '2025-04-30T23:45:10.000Z' })
  })
  it('rejects missing anchors instead of resetting credits', () => {
    expect(() => monthlyUsagePeriod('', '2026-09-09')).toThrow()
    expect(() => monthlyUsagePeriod('2026-09-10', '2026-09-09')).toThrow()
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
