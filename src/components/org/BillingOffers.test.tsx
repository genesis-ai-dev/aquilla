import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillingOffers } from './BillingOffers'
import { presentBillingOffers } from '../../../auth-worker/src/lib/billing/catalog-view'
import type { PriceCatalog, StripePriceInput } from '../../../auth-worker/src/lib/billing/pricing-model'
import { stripeCatalogResponse } from '../../../auth-worker/src/__tests__/helpers/stripe-catalog'
import manifest from '../../../config/pricing/stripe-sandbox.json'
const unavailableOffers = () => ({ available: false, priceVersion: null,
  entitlementVersion: null, usageInterval: 'week', checkoutEnabled: false, offers: [] })

async function realCatalog() {
  return presentBillingOffers(manifest as PriceCatalog, manifest.bindings.map(binding =>
    stripeCatalogResponse(`/v1/prices/${binding.priceId}`) as StripePriceInput))
}
afterEach(() => vi.unstubAllGlobals())

describe('Stripe catalog → billing client → plan comparison', () => {
  it('renders real composed prices, annual totals, audience tabs and monthly selection', async () => {
    const catalog = await realCatalog()
    const fetch = vi.fn(async () => Response.json(catalog))
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<BillingOffers jwt="jwt" orgId={7} />)
    expect(await screen.findByText('$6,000.00 billed annually')).toBeVisible()
    expect(screen.getByText('$7,200.00 billed annually')).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Team & Enterprise' })).toHaveAttribute('aria-selected', 'true')
    expect(fetch.mock.calls[0]).toBeDefined()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/orgs/7/billing/offers'), expect.objectContaining({
      headers: { Authorization: 'Bearer jwt' },
    }))
    await user.click(screen.getByRole('tab', { name: 'Individual' }))
    expect(await screen.findByText('$200.00 billed annually')).toBeVisible()
    await user.click(screen.getByRole('combobox', { name: 'Plan billing period' }))
    await user.click(screen.getByRole('option', { name: 'Monthly' }))
    expect(await screen.findByText('$20.00/month')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Pro coming soon' })).toBeDisabled()
    expect(document.body.textContent).not.toMatch(/credits|\b4000\b|\b1000\b|price_1/)
    expect(document.body.textContent).toContain('every seven days')
  })
  it.each(['missing', 'failure'])('hides amounts on %s pricing and retains inquiry actions', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'missing'
      ? Response.json(unavailableOffers()) : new Response('', { status: 503 })))
    render(<BillingOffers jwt="jwt" orgId={7} />)
    expect(await screen.findByText(/Plan prices are temporarily unavailable/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Discuss your rollout' })).toBeVisible()
    expect(document.body.textContent).not.toMatch(/\$|credits/)
  })
  it('discards a stale response after switching workspaces', async () => {
    const catalog = await realCatalog()
    let resolveOld!: (value: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(Response.json(unavailableOffers()))
    vi.stubGlobal('fetch', fetch)
    const { rerender } = render(<BillingOffers jwt="jwt" orgId={7} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    rerender(<BillingOffers jwt="jwt" orgId={8} />)
    expect(await screen.findByText(/Plan prices are temporarily unavailable/)).toBeVisible()
    resolveOld(Response.json(catalog))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(document.body.textContent).not.toContain('$')
  })
})
