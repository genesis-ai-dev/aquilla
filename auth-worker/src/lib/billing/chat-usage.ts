import type { Env } from '../../types'
import { readProviderCostCents } from '../../../../db/shared/billing-cost'
import { reserveWorkspaceUsage, settleWorkspaceUsage } from './workspace-usage'

export interface ChatUsage { orgId: number; requestId: string }
const loopback = (url: string) => {
  const parsed = new URL(url)
  return ['http:', 'https:'].includes(parsed.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    && !parsed.username && !parsed.password
}

/** This first integration only targets the local scripted provider. Real
 * providers require validated request-cost bounds before enabling enforcement.
 */
export function chatUsageRehearsalAllowed(env: Env, requestUrl: string) {
  try {
    return env.WRANGLER_LOCAL === '1' && loopback(requestUrl)
      && Boolean(env.OPENROUTER_BASE_URL && loopback(env.OPENROUTER_BASE_URL))
  } catch { return false }
}
export async function admitChatUsage(env: Env, input: {
  orgId: number; userId: number; projectId: string; requestId: string
}) {
  // Scripted local provider reservation only; never an actual-cost fallback.
  const result = await reserveWorkspaceUsage(env.AQUILLA_PG, {
    ...input, rail: 'llm', maxRawCostCents: 1,
  })
  return result.created
}

/** Never discard valid generated content because accounting needs recovery.
 * The durable reservation stays held if cost is missing or persistence fails.
 */
export async function settleChatUsage(env: Env, usage: ChatUsage, body: unknown) {
  try {
    const cents = readProviderCostCents(body)
    await settleWorkspaceUsage(env.AQUILLA_PG, usage.orgId, usage.requestId, cents)
    return 'settled' as const
  } catch {
    console.warn('[billing] chat usage requires reconciliation', usage)
    return 'pending' as const
  }
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
          if (!settlementAttempted) console.warn('[billing] incomplete chat stream requires reconciliation', usage)
          controller.close(); reader.releaseLock()
        } else {
          observe(next.value)
          if (terminal && !invalid && cost !== undefined && !settlementAttempted) {
            settlementAttempted = true
            await settleChatUsage(env, usage, cost)
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
    },
  })
}
