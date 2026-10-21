// The auth-worker's door to the one entitlement check (unified billing T5,
// AQU-2062). Every paid call on the already-metered paths — chat, agent,
// import classify, smart edits, autopilot, transcription — admits here, so
// each one gets its key, plan, ceiling and reservation from
// checkAiEntitlement instead of a hand-rolled guard.
//
// One ledger per call. When the meter records the call (`usage` is set), the
// call settles on workspace_usage_requests and the caller writes nothing to
// the legacy credit/word ledgers. When it does not (meter off), the legacy
// guards and ledgers remain the only record. The spend ceiling sums both, so
// writing both would count the call twice.
import { z } from 'zod'
import type { Env } from '../../types'
import type { CostRail } from '../../../../db/shared/billing-cost'
import { checkAiEntitlement, meterMode, type MeterMode } from '../../../../db/shared/ai-entitlement'
import { checkAiSpendCeiling } from '../../../../db/shared/ai-spend-ceiling'
import { weeklyUsageActive } from './usage-mode'
import type { ChatUsage } from './chat-usage'

/** BILLING_METER_MODE decides when it is set. Until then the pre-T4 switch
 *  keeps its meaning, so no deployed environment changes behaviour with this
 *  release: BILLING_WEEKLY_USAGE_ENFORCE=true is `enforce`, and the local
 *  rehearsal is `enforce` behind its loopback gate (`unavailable` outside it). */
export function paidCallMeterMode(env: Env, requestUrl?: string): MeterMode | 'unavailable' {
  if (env.BILLING_METER_MODE?.trim()) return meterMode(env)
  const weekly = weeklyUsageActive(env, requestUrl)
  return weekly === 'on' ? 'enforce' : weekly
}

export type PaidCallRefusal = {
  ok: false
  status: 400 | 402 | 403 | 409 | 503
  body: { error: string; message?: string } & Record<string, unknown>
}
export type PaidCallGate =
  /** `usage` is set when the meter reserved this call: settle, hold or
   *  release it (chat-usage.ts). Absent, the legacy ledgers record the call. */
  | { ok: true; apiKey: string; usage?: ChatUsage }
  | PaidCallRefusal

export interface PaidCallInput {
  orgId: number
  /** null is the system: background work with no live user (spec §3.3). */
  userId: number | null
  projectId: string | null
  rail: CostRail
  /** Default `openrouter`. A Modal service passes its own secret as houseKey;
   *  the agent sandbox (`cloudflare`, AQU-2066) passes AGENT_SANDBOX_KEY. */
  provider?: 'openrouter' | 'modal' | 'cloudflare'
  houseKey?: string
  /** The caller's URL, for the local rehearsal gate. Background work has none. */
  requestUrl?: string
  /** A client-supplied Idempotency-Key. Checked only when the call is metered. */
  idempotencyKey?: string
  /** Upper bound on raw provider cost in cents, read only when the meter
   *  reserves. Omitted: a preflight that checks plan, key and ceiling and
   *  reserves nothing, for runs that reserve each provider call themselves. */
  estimate?: () => number | Promise<number>
}

const refuse = (status: PaidCallRefusal['status'], error: string, message?: string): PaidCallRefusal =>
  ({ ok: false, status, body: { error, ...(message ? { message } : {}) } })

export async function admitPaidCall(env: Env, input: PaidCallInput): Promise<PaidCallGate> {
  const mode = paidCallMeterMode(env, input.requestUrl)
  if (mode === 'unavailable') return refuse(503, 'usage_rehearsal_unavailable')
  // Org 0 is the legacy no-org fallback (project-less chat, an unowned
  // project). It has no plan, so the meter never bills it; with the meter off
  // it keeps the platform ceiling and the house key, as before.
  if (input.orgId <= 0) {
    if (mode !== 'off') return refuse(403, 'forbidden', 'This project has no billing workspace')
    const ceiling = await checkAiSpendCeiling(env.AQUILLA_PG, env, input.rail)
    if (!ceiling.ok) return { ok: false, status: ceiling.status, body: ceiling.body }
    const houseKey = input.houseKey ?? (input.provider && input.provider !== 'openrouter' ? undefined : env.OPENROUTER_API_KEY)
    return houseKey ? { ok: true, apiKey: houseKey } : refuse(503, 'provider_unconfigured')
  }
  const reserve = mode !== 'off' && input.estimate !== undefined
  let requestId: string = crypto.randomUUID()
  let estimateRawCents = 0
  if (reserve) {
    if (input.idempotencyKey !== undefined) {
      if (!z.string().uuid().safeParse(input.idempotencyKey).success) return refuse(400, 'invalid_request_id')
      requestId = input.idempotencyKey
    }
    try { estimateRawCents = await input.estimate!() } catch (error) {
      return error instanceof Error && error.message === 'Model price unavailable'
        ? refuse(503, 'model_price_unavailable') : refuse(503, 'usage_accounting_unavailable')
    }
  }
  try {
    // A run-scoped env inherits its secrets (agent.ts runScopedEnv), so derive
    // from it rather than spreading it: a spread drops inherited keys.
    const entitlementEnv = Object.assign(Object.create(env) as Env, { BILLING_METER_MODE: mode })
    const entitlement = await checkAiEntitlement(env.AQUILLA_PG, entitlementEnv, {
      orgId: input.orgId, userId: input.userId, projectId: input.projectId, rail: input.rail,
      provider: input.provider ?? 'openrouter', estimateRawCents, requestId,
    }, { reserve, ...(input.houseKey ? { houseKey: input.houseKey } : {}) })
    if (!entitlement.ok) return { ok: false, status: entitlement.status, body: entitlement.body }
    return { ok: true, apiKey: entitlement.key.apiKey,
      ...(entitlement.recorded ? { usage: { orgId: input.orgId, requestId } } : {}) }
  } catch (error) {
    console.warn('[billing] entitlement check failed', { orgId: input.orgId, rail: input.rail }, error)
    return refuse(503, 'usage_accounting_unavailable')
  }
}
