import { FRONTIER_BASE } from '../frontier/auth'
import { fetchWithTimeout } from '../frontier/orgs'
import type { BillingWorkspace } from '../../../db/shared/billing-workspace'
export type { BillingWorkspace } from '../../../db/shared/billing-workspace'

export async function getBillingWorkspace(jwt: string, orgId: number): Promise<BillingWorkspace> {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/workspace`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!response.ok) throw new Error('Workspace billing details are unavailable.')
  const workspace = await response.json() as BillingWorkspace
  if (workspace.orgId !== orgId) throw new Error('Workspace billing response mismatch')
  return workspace
}

export async function startWorkspaceBillingPortal(jwt: string, orgId: number): Promise<string> {
  const response = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${encodeURIComponent(String(orgId))}/billing/portal-rehearsal`,
    { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!response.ok) throw new Error('Billing management is unavailable. Please try again.')
  const result = await response.json() as { url?: unknown; sandbox?: unknown }
  const url = typeof result.url === 'string' ? new URL(result.url) : null
  if (result.sandbox !== true || !url || url.protocol !== 'https:'
    || url.hostname !== 'billing.stripe.com' || url.username || url.password || url.port) {
    throw new Error('Billing management returned an invalid destination.')
  }
  return url.toString()
}
