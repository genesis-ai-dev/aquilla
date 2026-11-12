import type { Env } from '../../types'
import { METERED_MAX_OUTPUT_TOKENS, openRouterEstimate, providerRefOf, settleChatUsage, holdChatUsage } from './chat-usage'
import { admitPaidCall } from './paid-call'

export type AgentStepRefusal = 'exhausted' | 'unpriced' | 'unavailable'
export type AgentStepAdmission = { ok: true; requestId: string } | { ok: false; reason: AgentStepRefusal }

/** Per-run usage meter for the agent (decision 2026-09-16): every paid model
 * call, including nested drafting, passes the one entitlement check
 * (AQU-2062) and reserves its own bound before it starts, then settles its
 * own reported cost. Exhaustion refuses the next step; it never discards work
 * already staged. Built only while the meter records (paidCallMeterMode).
 */
export class AgentUsageMeter {
  /** userId null is the system: a background run with no live user (spec §3.3). */
  constructor(private env: Env, private scope: { orgId: number; userId: number | null; projectId: string }) {}
  readonly maxOutputTokens = METERED_MAX_OUTPUT_TOKENS

  async admitStep(input: { model: string; promptChars: number; maxOutputTokens?: number }): Promise<AgentStepAdmission> {
    const gate = await admitPaidCall(this.env, { ...this.scope, rail: 'agent',
      estimate: openRouterEstimate(this.env, { model: input.model, promptChars: input.promptChars,
        maxOutputTokens: input.maxOutputTokens ?? this.maxOutputTokens }) })
    if (gate.ok) return gate.usage ? { ok: true, requestId: gate.usage.requestId } : { ok: false, reason: 'unavailable' }
    if (gate.status === 402) return { ok: false, reason: 'exhausted' }
    return { ok: false, reason: gate.body.error === 'model_price_unavailable' ? 'unpriced' : 'unavailable' }
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
