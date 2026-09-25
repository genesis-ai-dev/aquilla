import type { Env } from '../../types'
import { readProviderCostCents } from '../../../../db/shared/billing-cost'
import { recordUsageProviderRef, reserveWorkspaceUsage, settleWorkspaceUsage, validProviderRef } from './workspace-usage'
import { boundRequestCostCents, readRateCard } from './rate-card'
import { weeklyUsageActive } from './usage-mode'

/** Server-enforced output cap while metering; clients cannot raise it. */
export const METERED_MAX_OUTPUT_TOKENS = 4096

export interface ChatUsage { orgId: number; requestId: string }

/** Kept for callers; see `usage-mode.ts` for the off/rehearsal/enforce policy. */
export function chatUsageRehearsalAllowed(env: Env, requestUrl: string) {
  return weeklyUsageActive(env, requestUrl) === 'on'
}
export async function admitChatUsage(env: Env, input: {
  orgId: number; userId: number; projectId: string; requestId: string
  model: string; promptChars: number; maxOutputTokens: number
}) {
  const { model, promptChars, maxOutputTokens, ...request } = input
  const maxRawCostCents = boundRequestCostCents(await readRateCard(env), { model, promptChars, maxOutputTokens })
  const result = await reserveWorkspaceUsage(env.AQUILLA_PG, { ...request, rail: 'llm', maxRawCostCents })
  return result.created
}

/** Never discard valid generated content because accounting needs recovery.
 * The durable reservation stays held if cost is missing or persistence fails.
 */
export async function settleChatUsage(env: Env, usage: ChatUsage, body: unknown) {
  const ref = providerRefOf(body)
  try {
    const cents = readProviderCostCents(body)
    await settleWorkspaceUsage(env.AQUILLA_PG, usage.orgId, usage.requestId, cents, ref)
    return 'settled' as const
  } catch {
    console.warn('[billing] chat usage requires reconciliation', usage)
    await holdChatUsage(env, usage, ref)
    return 'pending' as const
  }
}
/** The provider's generation id lets a held reservation be reconciled from the
 * provider's own record later. Recording it never settles anything.
 */
export function providerRefOf(body: unknown) {
  const id = (body as { id?: unknown } | null)?.id
  return validProviderRef(id) ? id : undefined
}
export async function holdChatUsage(env: Env, usage: ChatUsage, ref: string | undefined) {
  if (ref === undefined) return
  try { await recordUsageProviderRef(env.AQUILLA_PG, usage.orgId, usage.requestId, ref) }
  catch { console.warn('[billing] chat usage provider reference not recorded', usage) }
}

/** Observe SSE with backpressure and bounded parser state; output bytes remain
 * unchanged. Settle before forwarding the terminal frame: clients may stop
 * reading immediately at [DONE], without draining transport EOF.
 * Cancellation/read errors retain the reservation rather than refunding spend.
 */
export function meterChatStream(source: ReadableStream<Uint8Array>, env: Env, usage: ChatUsage) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let cost: unknown
  let ref: string | undefined
  let terminal = false
  let invalid = false
  let settlementAttempted = false
  function line(value: string) {
    if (value === '') {
      const data = event.trim(); event = ''
      if (!data) return
      if (terminal) { invalid = true; return }
      if (data === '[DONE]') { terminal = true; return }
      try {
        const parsed = JSON.parse(data)
        ref ??= providerRefOf(parsed)
        if (parsed.error) invalid = true
        if (parsed.usage?.cost !== undefined) {
          // Validate now so a malformed final cost cannot reuse an earlier one.
          readProviderCostCents(parsed)
          cost = parsed
        }
      } catch { invalid = true }
    } else if (value.startsWith('data:')) {
      event += value.slice(5).trimStart() + '\n'
      if (event.length > 65536) { invalid = true; event = '' }
    }
  }
  function observe(bytes: Uint8Array) {
    if (invalid) return
    buffer += decoder.decode(bytes, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, newline).replace(/\r$/, ''))
      buffer = buffer.slice(newline + 1)
      if (invalid) { buffer = ''; return }
    }
    if (buffer.length > 65536) { invalid = true; buffer = '' }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          buffer += decoder.decode()
          if (buffer.trim() || event.trim()) invalid = true
          if (!settlementAttempted) {
            settlementAttempted = true
            console.warn('[billing] incomplete chat stream requires reconciliation', usage)
            await holdChatUsage(env, usage, ref)
          }
          controller.close(); reader.releaseLock()
        } else {
          observe(next.value)
          if (terminal && !invalid && cost !== undefined && !settlementAttempted) {
            settlementAttempted = true
            await settleChatUsage(env, usage, { ...(cost as object), ...(ref ? { id: ref } : {}) })
          }
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(error)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { reader.releaseLock() }
      if (!settlementAttempted) { settlementAttempted = true; await holdChatUsage(env, usage, ref) }
    },
  })
}
