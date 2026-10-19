import { describe, expect, it } from 'vitest'
import {
  weeklyAllowance, weeklyUsagePeriod, resolveApprovedPrice, resolveAllowancePolicy,
  rawUsdToAllowanceUnits, teamWeeklyRawUsd,
  type ApprovedPriceBinding, type Offer, type StripePriceInput,
} from './pricing-model'
const binding: ApprovedPriceBinding = {
  priceId: 'price_team_year', productId: 'prod_team', offer: 'team',
  interval: 'year', currency: 'usd', live: false, maxQuantity: 1,
}
const price: StripePriceInput = {
  id: binding.priceId, product: binding.productId, active: true,
  livemode: false, type: 'recurring', billing_scheme: 'per_unit',
  currency: 'usd', unit_amount: 500000,
  recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' },
}
describe('new pricing contract', () => {
  it.each<[Offer, number, number]>([
    // Free $1 raw at the 4× markup is 400 units; Team is 24× Free, flat per org.
    ['free', 1, 400], ['team', 1, 9600],
  ])('%s × %i replaces rather than adds base capacity', (offer, qty, credits) => {
    expect(weeklyAllowance(offer, qty)).toBe(credits)
  })
  it.each([0, -1, 1.5, 2, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid quantity %s', quantity => {
      expect(() => weeklyAllowance('team', quantity)).toThrow()
    },
  )
  it('rejects removed offers and extra Team quantity (AQU-2058: flat per org)', () => {
    expect(() => weeklyAllowance('max_20x' as Offer)).toThrow()
    expect(() => resolveApprovedPrice([binding], price, 2)).toThrow()
    expect(() => resolveApprovedPrice([{ ...binding, maxQuantity: 4 }], price, 2)).toThrow()
  })
  it('gives annual payment weekly capacity and Stripe-sourced amounts', () => {
    expect(resolveApprovedPrice([binding], price, 1)).toMatchObject({
      allowanceCredits: 9600, usageInterval: 'week', totalAmount: 500000,
      monthlyEquivalent: expect.closeTo(41666.67, 1), scope: 'team',
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

it('retains spent usage through the past-due grace and the Free fallback after it', async () => {
  const { remainingWeeklyAllowance } = await import('./pricing-model')
  const { resolveWorkspaceAccess } = await import('../../../../db/shared/workspace-access')
  const paidThrough = '2026-10-01T12:00:00Z'
  const failed = (now: string) => resolveWorkspaceAccess({ offer: 'team', paymentFailed: true,
    paidThrough, cancelAtPeriodEnd: false }, new Date(now))
  // Stripe is still retrying: Team stays on, so a 400-unit week keeps 9,200 left.
  const grace = failed('2026-10-08T11:59:59Z')
  expect(grace).toMatchObject({ offer: 'team', reason: 'payment_grace', graceEndsAt: '2026-10-08T12:00:00.000Z' })
  expect(remainingWeeklyAllowance(grace.offer, 400)).toBe(9200)
  // Seven days after the paid period, the same usage is over Free's cap.
  const lapsed = failed('2026-10-08T12:00:00Z')
  expect(lapsed).toMatchObject({ offer: 'free', reason: 'payment_failed' })
  expect(lapsed.graceEndsAt).toBeUndefined()
  expect(remainingWeeklyAllowance(lapsed.offer, 400)).toBe(0)
  expect(remainingWeeklyAllowance(lapsed.offer, 10)).toBe(390)
  expect(() => remainingWeeklyAllowance('team', -1)).toThrow()
  expect(() => remainingWeeklyAllowance('team', NaN)).toThrow()
})

describe('raw-dollar allowance policy (AQU-2056)', () => {
  it('defaults to Free $1/week raw and Team 24× Free, the 25%-of-annual-revenue sizing', () => {
    const policy = resolveAllowancePolicy(undefined)
    expect(policy).toEqual({ freeWeeklyRawUsd: 1, teamMultipleOfFree: 24 })
    // $5,000/yr ÷ 52 ≈ $96.15/week; Team at 100% must cost at most ~25% of that.
    expect(teamWeeklyRawUsd(policy)).toBeLessThanOrEqual(0.25 * 5000 / 52)
  })
  it('moves Team when an admin changes Free, so Team cannot drift from its sizing rule', () => {
    const policy = resolveAllowancePolicy({ freeWeeklyRawUsd: 2 })
    expect(weeklyAllowance('free', 1, policy)).toBe(800)
    expect(weeklyAllowance('team', 1, policy)).toBe(24 * 800)
    expect(weeklyAllowance('team', 1, resolveAllowancePolicy({ freeWeeklyRawUsd: 2, teamMultipleOfFree: 10 }))).toBe(8000)
  })
  it('converts raw dollars to meter units at the shared 4× markup in one place', () => {
    // The ledger stores raw cents × 4 as units; a $1 cap must equal $1 of raw spend.
    expect(rawUsdToAllowanceUnits(1)).toBe(400)
    expect(rawUsdToAllowanceUnits(0.0125)).toBe(5)
    expect(rawUsdToAllowanceUnits(0)).toBe(0)
  })
  it.each([
    { freeWeeklyRawUsd: -1 }, { freeWeeklyRawUsd: '1' }, { freeWeeklyRawUsd: NaN },
    { teamMultipleOfFree: 0 }, { teamMultipleOfFree: Infinity },
  ])('rejects a corrupt stored policy %j instead of metering against it', stored => {
    expect(() => resolveAllowancePolicy(stored)).toThrow()
  })
})
