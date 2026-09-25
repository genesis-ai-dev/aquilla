import { afterEach, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillingOffers } from './BillingOffers'
import { presentBillingOffers } from '../../../auth-worker/src/lib/billing/catalog-view'
import { stripeCatalogResponse, testStripeCatalog } from '../../../auth-worker/src/__tests__/helpers/stripe-catalog'
import type { StripePriceInput } from '../../../auth-worker/src/lib/billing/pricing-model'
import type { BillingChangeReview } from '../../../db/shared/billing-change-review'
const catalog = presentBillingOffers(testStripeCatalog, testStripeCatalog.bindings.map(b =>
  stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput))
const review: BillingChangeReview = { id: '0fa739a0-6b94-49b9-b649-01ae34acaa98',
  workspace: { orgId: 7, name: 'Translation team', scope: 'team' }, direction: 'upgrade',
  currentOffer: 'team', target: catalog.offers.find(o => o.offer === 'team_20x' && o.interval === 'year')!,
  amountDueNow: 365, effectiveAt: '2026-09-12T12:00:00Z', expiresAt: '2026-09-12T12:15:00Z',
  usagePeriodStart: '2026-09-10T12:00:00Z', usagePeriodEnd: '2026-09-17T12:00:00Z', changesEnabled: false }
afterEach(() => vi.unstubAllGlobals())
function responses(value = review) {
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('/offers') ? catalog : value))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
it('renders a change amount through the actual client without enabling a charge', async () => {
  const fetch = responses()
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} changingPlan />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  const region = screen.getByRole('region', { name: 'Review plan change' })
  expect(region).toHaveFocus()
  expect(await within(region).findByText('$3.65')).toBeVisible()
  expect(region).toHaveTextContent('after successful payment')
  expect(region).toHaveTextContent('Your usage this week stays counted')
  expect(within(region).getByRole('button', { name: 'Plan changes coming soon' })).toBeDisabled()
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/orgs/7/billing/change-rehearsal/review'),
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ offer: 'team_20x', interval: 'year', quantity: 1 }) }))
  expect(region).not.toHaveTextContent(/credits|price_1/)
})
it('shows renewal timing and retained usage for a downgrade', async () => {
  responses({ ...review, direction: 'downgrade', currentOffer: 'team_20x', amountDueNow: 0,
    target: catalog.offers.find(o => o.offer === 'team' && o.interval === 'year')!,
    effectiveAt: '2027-09-12T12:00:00Z' })
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} changingPlan />)
  await user.click(await screen.findByRole('button', { name: 'Review Team' }))
  expect(await screen.findByText(/No charge now/)).toHaveTextContent('next billing cycle')
  expect(screen.getByText(/Your current plan and cap continue/)).toHaveTextContent('usage week does not restart')
})
it('rejects mismatched reviews and permits a new explicit review', async () => {
  const fetch = responses({ ...review, workspace: { ...review.workspace, orgId: 8 } })
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} changingPlan />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('current plan stays unchanged')
  fetch.mockResolvedValueOnce(Response.json(review))
  await user.click(screen.getByRole('button', { name: 'Try change review again' }))
  expect(await screen.findByText('$3.65')).toBeVisible()
})
it('discards a pending change review when the workspace changes', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/offers')
    ? Response.json(catalog) : new Promise<Response>(done => { resolve = done })))
  const user = userEvent.setup()
  const { rerender } = render(<BillingOffers jwt="jwt" orgId={7} changingPlan />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByText('Checking the subscription and change amount…')).toBeVisible()
  rerender(<BillingOffers jwt="jwt" orgId={8} changingPlan />)
  await act(async () => resolve(Response.json(review)))
  expect(screen.queryByRole('region', { name: 'Review plan change' })).toBeNull()
})
it('starts plan changes in the workspace’s current billing interval', async () => {
  const fetch = responses({ ...review, target: catalog.offers.find(o => o.offer === 'team_20x' && o.interval === 'month')! })
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} changingPlan currentInterval="month" />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByText('$3.65')).toBeVisible()
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/billing/change-rehearsal/review'),
    expect.objectContaining({ body: JSON.stringify({ offer: 'team_20x', interval: 'month', quantity: 1 }) }))
})
