import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { BillingWorkspaceSummary } from './BillingWorkspaceSummary'
import type { BillingWorkspace } from '@/lib/sync/billing-workspace'

const workspace: BillingWorkspace = {
  orgId: 7, name: 'Translation team', scope: 'team',
  eligibility: { reason: 'ready', offers: ['team', 'team_20x'] },
  entitlement: null, usagePercent: null, checkoutEnabled: false,
}
afterEach(() => vi.unstubAllGlobals())
describe('billing workspace API → client → settings', () => {
  it('shows the authoritative target and ownership rule without invented usage', async () => {
    const fetch = vi.fn(async () => Response.json(workspace))
    vi.stubGlobal('fetch', fetch)
    render(<BillingWorkspaceSummary jwt="jwt" orgId={7} />)
    expect(await screen.findByText('Translation team')).toBeVisible()
    expect(screen.getByText('Team workspace — shared billing')).toBeVisible()
    expect(screen.getByText(/personal subscription does not add capacity/)).toBeVisible()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/orgs/7/billing/workspace'), expect.objectContaining({ headers: { Authorization: 'Bearer jwt' } }))
    expect(document.body.textContent).not.toMatch(/credits|0%|100%/)
  })
  it.each([
    ['scope_unconfirmed', /Confirm this workspace’s type/],
    ['covered_access', /This workspace has covered access/],
    ['existing_billing', /existing billing or an agreed allowance/],
    ['personal_collaboration_review', /has collaborators/],
  ] as const)('explains %s without offering a purchase', async (reason, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...workspace, eligibility: { reason, offers: [] } })))
    render(<BillingWorkspaceSummary jwt="jwt" orgId={7} />)
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('rejects a response for another workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...workspace, orgId: 8 })))
    render(<BillingWorkspaceSummary jwt="jwt" orgId={7} />)
    expect(await screen.findByText(/details are unavailable/)).toBeVisible()
    expect(screen.queryByText('Translation team')).toBeNull()
  })
  it('discards a late response after navigating to another workspace', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
      .mockResolvedValueOnce(Response.json({ ...workspace, orgId: 8, name: 'Other team' }))
    vi.stubGlobal('fetch', fetch)
    const { rerender } = render(<BillingWorkspaceSummary jwt="jwt" orgId={7} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    rerender(<BillingWorkspaceSummary jwt="jwt" orgId={8} />)
    expect(await screen.findByText('Other team')).toBeVisible()
    await act(async () => { resolve(Response.json(workspace)) })
    expect(screen.getByText('Other team')).toBeVisible()
    expect(screen.queryByText('Translation team')).toBeNull()
  })
})
