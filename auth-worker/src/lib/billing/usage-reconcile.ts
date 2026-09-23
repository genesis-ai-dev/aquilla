import type { Env } from '../../types'
import { providerCostToMicroCents } from '../../../../db/shared/billing-cost'
import { listHeldUsage, readUsageRequest, settleWorkspaceUsage } from './workspace-usage'

export type UsageReconcileStatus = 'settled' | 'already_settled' | 'released' | 'unreferenced' | 'unavailable'

/** Resolve a held reservation from the provider's generation record. The
 * provider's own report is the only evidence that settles or values the work;
 * missing, mismatched, or malformed records keep the reservation held. Nothing
 * here releases usage: unknown completion is never proof of no charge.
 */
export async function reconcileHeldUsage(env: Env, orgId: number, requestId: string): Promise<{ status: UsageReconcileStatus }> {
  const request = await readUsageRequest(env.AQUILLA_PG, orgId, requestId)
  if (!request) throw new Error('Usage reservation not found')
  if (request.state === 'settled') return { status: 'already_settled' }
  if (request.state === 'released') return { status: 'released' }
  if (request.provider_ref === null) return { status: 'unreferenced' }
  const cents = await fetchGenerationCostCents(env, request.provider_ref)
  if (cents === undefined) return { status: 'unavailable' }
  try {
    await settleWorkspaceUsage(env.AQUILLA_PG, orgId, requestId, cents, request.provider_ref)
    return { status: 'settled' }
  } catch (error) {
    if (error instanceof Error && error.message === 'Usage settlement conflict') throw error
    return { status: 'unavailable' }
  }
}

/** OpenRouter-shaped generation lookup: `{ data: { id, total_cost } }` in dollars. */
async function fetchGenerationCostCents(env: Env, ref: string): Promise<number | undefined> {
  if (!env.OPENROUTER_BASE_URL || !env.OPENROUTER_API_KEY) return undefined
  try {
    const url = `${env.OPENROUTER_BASE_URL.replace(/\/$/, '')}/generation?id=${encodeURIComponent(ref)}`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: { id?: unknown; total_cost?: unknown } } | null
    const record = body?.data
    if (record?.id !== ref || typeof record.total_cost !== 'number') return undefined
    const cents = record.total_cost * 100
    providerCostToMicroCents(cents)
    return cents
  } catch { return undefined }
}

export async function heldUsageSummary(env: Env, orgId: number) {
  const held = await listHeldUsage(env.AQUILLA_PG, orgId)
  return held.map(row => ({ requestId: row.request_id, rail: row.rail, projectId: row.project_id,
    createdAt: row.created_at, referenced: row.provider_ref !== null }))
}
