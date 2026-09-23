import { afterEach, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillingOffers } from './BillingOffers'
import { presentBillingOffers } from '../../../auth-worker/src/lib/billing/catalog-view'
import { reviewBillingPlan } from '../../../auth-worker/src/lib/billing/review'
import { stripeCatalogResponse } from '../../../auth-worker/src/__tests__/helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'
import type { PriceCatalog, StripePriceInput } from '../../../auth-worker/src/lib/billing/pricing-model'
import type { BillingWorkspace } from '../../../db/shared/billing-workspace'
const catalog = presentBillingOffers(manifest as PriceCatalog, manifest.bindings.map(b =>
  stripeCatalogResponse(`/v1/prices/${b.priceId}`) as StripePriceInput))
const workspace: BillingWorkspace = { orgId: 7, name: 'Translation team', scope: 'team',
  eligibility: { reason: 'ready', offers: ['team', 'team_20x'] }, entitlement: null,
  usagePercent: null, checkoutEnabled: false }
const selection = { offer: 'team_20x', interval: 'year', quantity: 1 } as const
const review = reviewBillingPlan(workspace, selection, catalog)
afterEach(() => vi.unstubAllGlobals())
function responses(value = review) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/offers')) return Response.json(catalog)
    expect(JSON.parse(String(init?.body))).toEqual(selection)
    return Response.json(value)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
it('passes server review through the real client and confirms workspace, offer, and annual total', async () => {
  const fetch = responses()
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(screen.getByRole('region', { name: 'Review selected plan' })).toHaveFocus()
  const region = within(screen.getByRole('region', { name: 'Review selected plan' }))
  expect(await region.findByText('Translation team')).toBeVisible()
  expect(region.getByText('$7,200.00 billed annually.')).toBeVisible()
  expect(region.getByText('Equivalent to $600.00/month.')).toBeVisible()
  expect(region.getByRole('button', { name: 'Checkout coming soon' })).toBeDisabled()
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/orgs/7/billing/review'),
    expect.objectContaining({ method: 'POST', headers: {
      Authorization: 'Bearer jwt', 'Content-Type': 'application/json',
    } }))
  expect(document.body.textContent).not.toMatch(/credits|price_1/)
  await user.click(region.getByRole('button', { name: 'Close plan review' }))
  expect(screen.queryByRole('region', { name: 'Review selected plan' })).not.toBeInTheDocument()
})
it('explains server-side covered access without offering checkout', async () => {
  responses(reviewBillingPlan({ ...workspace, eligibility: { reason: 'covered_access', offers: [] } }, selection, catalog))
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByText(/This workspace has covered access/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Checkout coming soon' })).not.toBeInTheDocument()
})
it('rejects a response for another workspace and allows an explicit retry', async () => {
  const fetch = responses({ ...review, workspace: { ...review.workspace, orgId: 8 } })
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Plan review is unavailable')
  fetch.mockResolvedValueOnce(Response.json(review))
  await user.click(screen.getByRole('button', { name: 'Try review again' }))
  expect(await screen.findByText('Translation team')).toBeVisible()
})
it('discards a pending review on workspace navigation', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/offers')
    ? Response.json(catalog) : new Promise<Response>(done => { resolve = done })))
  const user = userEvent.setup()
  const { rerender } = render(<BillingOffers jwt="jwt" orgId={7} />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByText('Checking workspace and current prices…')).toBeVisible()
  rerender(<BillingOffers jwt="jwt" orgId={8} />)
  await act(async () => resolve(Response.json(review)))
  expect(screen.queryByRole('region', { name: 'Review selected plan' })).not.toBeInTheDocument()
  expect(screen.queryByText('Translation team')).not.toBeInTheDocument()
})
it('clears review when the billing interval changes', async () => {
  responses()
  const user = userEvent.setup()
  render(<BillingOffers jwt="jwt" orgId={7} />)
  await user.click(await screen.findByRole('button', { name: 'Review Team 20×' }))
  expect(await screen.findByText('Translation team')).toBeVisible()
  await user.click(screen.getByRole('combobox', { name: 'Plan billing period' }))
  await user.click(screen.getByRole('option', { name: 'Monthly' }))
  expect(screen.queryByRole('region', { name: 'Review selected plan' })).not.toBeInTheDocument()
})
