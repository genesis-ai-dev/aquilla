import type { Env } from '../../types'
import { chatUsageRehearsalAllowed, METERED_MAX_OUTPUT_TOKENS, providerRefOf, settleChatUsage, holdChatUsage } from './chat-usage'
import { boundRequestCostCents, readRateCard } from './rate-card'
import { reserveWorkspaceUsage } from './workspace-usage'

export type AgentStepRefusal = 'exhausted' | 'unpriced' | 'unavailable'
export type AgentStepAdmission = { ok: true; requestId: string } | { ok: false; reason: AgentStepRefusal }

/** Per-run weekly-usage meter for the agent (decision 2026-09-16): every paid
 * model call, including nested drafting, reserves its own bound before it
 * starts and settles its own reported cost. Exhaustion refuses the next step;
 * it never discards work already staged. Same local rehearsal gate as chat.
 */
export class AgentUsageMeter {
  constructor(private env: Env, private scope: { orgId: number; userId: number; projectId: string }) {}
  readonly maxOutputTokens = METERED_MAX_OUTPUT_TOKENS

  async admitStep(input: { model: string; promptChars: number; maxOutputTokens?: number }): Promise<AgentStepAdmission> {
    let maxRawCostCents: number
    try {
      maxRawCostCents = boundRequestCostCents(await readRateCard(this.env),
        { model: input.model, promptChars: input.promptChars, maxOutputTokens: input.maxOutputTokens ?? this.maxOutputTokens })
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.message === 'Model price unavailable' ? 'unpriced' : 'unavailable' }
    }
    const requestId = crypto.randomUUID()
    try {
      await reserveWorkspaceUsage(this.env.AQUILLA_PG, { ...this.scope, requestId, rail: 'agent', maxRawCostCents })
      return { ok: true, requestId }
    } catch (error) {
      if (error instanceof Error && error.message === 'Weekly AI allowance exhausted') return { ok: false, reason: 'exhausted' }
      return { ok: false, reason: 'unavailable' }
    }
  }
  /** Settle from the provider body (`id` + `usage.cost`); missing cost holds
   * the reservation with its generation reference for reconciliation. */
  settleStep(requestId: string, body: unknown) {
    return settleChatUsage(this.env, { orgId: this.scope.orgId, requestId }, body)
  }
  /** The call failed or was cut off: keep the reservation, record any id. */
  holdStep(requestId: string, body: unknown) {
    return holdChatUsage(this.env, { orgId: this.scope.orgId, requestId }, providerRefOf(body))
  }
}

export function agentUsageEnabled(env: Env) { return env.BILLING_CHAT_USAGE_REHEARSAL === 'true' }
export function agentUsageAllowed(env: Env, requestUrl: string) { return chatUsageRehearsalAllowed(env, requestUrl) }
/** Background work has no request URL; the provider URL carries the loopback gate. */
export function backgroundUsageAllowed(env: Env) {
  return Boolean(env.OPENROUTER_BASE_URL) && chatUsageRehearsalAllowed(env, env.OPENROUTER_BASE_URL!)
}
/** Shape shared with the draft tool: reserve now, settle or hold after. */
export type PaidCallAdmit = (input: { model: string; promptChars: number; maxOutputTokens?: number }) => Promise<
  { ok: true; settle: (body: unknown) => Promise<unknown>; hold: (body: unknown) => Promise<unknown> }
  | { ok: false; reason: AgentStepRefusal }>
export function paidCallAdmit(meter: AgentUsageMeter): PaidCallAdmit {
  return async input => {
    const admission = await meter.admitStep(input)
    if (!admission.ok) return admission
    return { ok: true, settle: body => meter.settleStep(admission.requestId, body), hold: body => meter.holdStep(admission.requestId, body) }
  }
}
