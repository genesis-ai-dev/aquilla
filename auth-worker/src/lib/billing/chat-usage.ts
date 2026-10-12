import type { Env } from '../../types'
import { readProviderCostCents } from '../../../../db/shared/billing-cost'
import { recordUsageProviderRef, releaseWorkspaceUsage, reserveWorkspaceUsage, settleWorkspaceUsage, validProviderRef } from './workspace-usage'
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

/** Does this upstream rejection prove the model never ran (AQU-1241)?
 *
 * Only a gateway-side refusal qualifies. A 4xx is decided before any generation
 * exists, so the request is proven free; 408 is excluded because a timed-out
 * request may already be generating, and 5xx is excluded because an upstream
 * failure can follow a completed generation. Both stay held under
 * `releaseWorkspaceUsage`'s rule that uncertainty is not evidence of no charge.
 * A rejection that still names a generation record is not proven free either.
 */
export function providerRejectedPreModel(status: number, body: string) {
  if (status < 400 || status >= 500 || status === 408) return false
  try { return providerRefOf(JSON.parse(body)) === undefined }
  catch { return true } // no parseable body means no generation to reconcile
}

/** Release a reservation the provider proved free, so it stops counting against
 * the workspace's allowance. Never throws: a release that cannot be recorded
 * leaves the reservation held for reconciliation rather than losing the row.
 */
export async function releaseChatUsage(env: Env, usage: ChatUsage) {
  try {
    await releaseWorkspaceUsage(env.AQUILLA_PG, usage.orgId, usage.requestId)
    return 'released' as const
  } catch {
    console.warn('[billing] chat usage release failed; reservation held', usage)
    return 'pending' as const
  }
}

/** What an SSE scan learned about the provider's own cost report. Shared by
 * both chat rails so each reads one parser's answer rather than its own.
 */
interface SseScan {
  /** The frame carrying the provider's usage block, once one has been seen. */
  cost: unknown
  /** The provider's generation id, for reconciling a held reservation later. */
  ref: string | undefined
  /** The `[DONE]` frame has been seen, so the reply is complete. */
  terminal: boolean
  /** The stream is not trustworthy: malformed, truncated, oversized, or an
   *  error frame. A cost read off an invalid stream is not a cost. */
  invalid: boolean
}

/** Scan SSE `data:` frames with bounded parser state, only to learn the cost
 * the provider reports for itself. Bytes are never altered or withheld — the
 * caller forwards every chunk it hands in.
 */
function sseCostScanner() {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  const scan: SseScan = { cost: undefined, ref: undefined, terminal: false, invalid: false }
  function line(value: string) {
    if (value === '') {
      const data = event.trim(); event = ''
      if (!data) return
      if (scan.terminal) { scan.invalid = true; return }
      if (data === '[DONE]') { scan.terminal = true; return }
      try {
        const parsed = JSON.parse(data)
        scan.ref ??= providerRefOf(parsed)
        if (parsed.error) scan.invalid = true
        if (parsed.usage?.cost !== undefined) {
          // Validate now so a malformed final cost cannot reuse an earlier one.
          readProviderCostCents(parsed)
          scan.cost = parsed
        }
      } catch { scan.invalid = true }
    } else if (value.startsWith('data:')) {
      event += value.slice(5).trimStart() + '\n'
      if (event.length > 65536) { scan.invalid = true; event = '' }
    }
  }
  return {
    scan,
    observe(bytes: Uint8Array) {
      if (scan.invalid) return
      buffer += decoder.decode(bytes, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
        if (scan.invalid) { buffer = ''; return }
      }
      if (buffer.length > 65536) { scan.invalid = true; buffer = '' }
    },
    /** Flush at EOF: anything still buffered is a half-delivered frame. */
    finish() {
      buffer += decoder.decode()
      if (buffer.trim() || event.trim()) scan.invalid = true
    },
  }
}

/** The provider-reported cost of a completed stream, or undefined when the
 * stream reported none, broke, or was never trustworthy. Never a guess.
 */
function scannedCostCents(scan: SseScan): number | undefined {
  if (scan.invalid || scan.cost === undefined) return undefined
  try { return readProviderCostCents(scan.cost) }
  catch { return undefined }
}

/** Observe SSE with backpressure and bounded parser state; output bytes remain
 * unchanged. Settle before forwarding the terminal frame: clients may stop
 * reading immediately at [DONE], without draining transport EOF.
 * Cancellation/read errors retain the reservation rather than refunding spend.
 */
export function meterChatStream(source: ReadableStream<Uint8Array>, env: Env, usage: ChatUsage) {
  const reader = source.getReader()
  const { scan, observe, finish } = sseCostScanner()
  let settlementAttempted = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          finish()
          if (!settlementAttempted) {
            settlementAttempted = true
            console.warn('[billing] incomplete chat stream requires reconciliation', usage)
            await holdChatUsage(env, usage, scan.ref)
          }
          controller.close(); reader.releaseLock()
        } else {
          observe(next.value)
          if (scan.terminal && !scan.invalid && scan.cost !== undefined && !settlementAttempted) {
            settlementAttempted = true
            await settleChatUsage(env, usage, { ...(scan.cost as object), ...(scan.ref ? { id: scan.ref } : {}) })
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
      if (!settlementAttempted) { settlementAttempted = true; await holdChatUsage(env, usage, scan.ref) }
    },
  })
}

/** A streamed reply whose provider-reported cost the legacy credit ledger can
 * read once the stream is over (AQU-1871).
 */
export interface ObservedChatStream {
  /** Forward this in place of the upstream body; the bytes are identical. */
  body: ReadableStream<Uint8Array>
  /** Resolves when the stream ends — completed, cancelled, or failed. */
  ended: Promise<void>
  /** Provider-reported cost in cents, set by the time `ended` resolves.
   *  Undefined means the provider reported no usable cost for this stream. */
  costCents?: number
}

/** Read the cost of a streamed reply on the legacy (unmetered) rail.
 *
 * The legacy rail has no reservation to settle, so unlike `meterChatStream`
 * this withholds nothing and awaits nothing in the client's path: it scans the
 * frames as they pass, and the caller's deferred ledger write reads the answer
 * once `ended` resolves. A stream that never reports a cost leaves `costCents`
 * undefined — an unresolved cost, never an invented flat charge.
 */
export function observeChatStreamCost(source: ReadableStream<Uint8Array>): ObservedChatStream {
  const reader = source.getReader()
  const { scan, observe, finish } = sseCostScanner()
  let resolveEnded: () => void
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve })
  const observed: ObservedChatStream = { body: undefined as unknown as ReadableStream<Uint8Array>, ended }
  let ending = false
  /** Idempotent: the stream ends exactly once, however it ends. */
  function end() {
    if (ending) return
    ending = true
    observed.costCents = scannedCostCents(scan)
    resolveEnded()
  }
  observed.body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          finish()
          controller.close(); reader.releaseLock(); end()
        } else {
          observe(next.value)
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(error)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
        end()
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { reader.releaseLock(); end() }
    },
  })
  return observed
}
