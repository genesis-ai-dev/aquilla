import { expect, it } from 'vitest'
import { billingSelectionPath, onboardingForBillingNext, readBillingIntent } from './intent'
import { loginPath, safeLoginNext } from '../navigation/login-path'

it.each(['pro', 'max-5x', 'max-20x', 'team', 'team-20x'])(
  'preserves marketing %s through login and signup destinations', offer => {
    for (const interval of ['annual', 'monthly']) {
      const intent = readBillingIntent(new URLSearchParams({ offer, interval, quantity: '1',
        audience: offer.startsWith('team') ? 'team' : 'individual' }))
      expect(intent.kind).toBe('paid')
      if (intent.kind !== 'paid') throw new Error('Expected paid intent')
      const path = billingSelectionPath(intent.selection)
      const next = safeLoginNext(new URL(loginPath({ next: path }), 'https://test').searchParams.get('next'))
      expect(next).toBe(path)
      expect(readBillingIntent(new URL(onboardingForBillingNext(next), 'https://test').searchParams)).toEqual(intent)
    }
  },
)
it.each(['offer=field&interval=year&quantity=1', 'offer=pro&interval=year&quantity=2',
  'offer=pro&interval=year&quantity=1&amount=1', 'offer=pro&interval=year&quantity=1&offer=team',
  'offer=pro&interval=year&quantity=1&audience=team', 'offer=pro&interval=constructor&quantity=1',
  'offer=constructor&interval=year&quantity=1', 'offer=pro'])('rejects invalid intent %s', query => {
  expect(readBillingIntent(new URLSearchParams(query))).toEqual({ kind: 'invalid' })
})
it('keeps ordinary and free onboarding unchanged and does not accept arbitrary return destinations', () => {
  expect(readBillingIntent(new URLSearchParams())).toEqual({ kind: 'none' })
  expect(readBillingIntent(new URLSearchParams('offer=free&interval=annual&quantity=1&audience=individual'))).toEqual({ kind: 'none' })
  expect(onboardingForBillingNext('/app')).toBe('/onboarding')
  expect(onboardingForBillingNext('https://evil.test/billing/select?offer=pro&interval=year&quantity=1')).toBe('/onboarding')
})
