// AQU-2063 (unified billing T6): the auth-worker OpenRouter paths that were
// never on the weekly meter — DraftCells, brief summary, the import sandbox's
// parser model, knowledge indexing, the Monday and Airtable analyses and the
// tools builder (spec §3.2 rows 10, 11, 12, 23, 24, 25). Each provider call
// admits through T5's admitPaidCall (paid-call.ts: plan, key, ceiling, the
// BILLING_METER_MODE mapping) before it spends, and settles the provider's own
// `usage.cost` after, one ledger row per call.
//
// These paths are non-streaming and may make several calls per job (research
// then draft, one call per summary batch, a parse retry), so each call admits
// on its own: a job that crosses 100% stops at its next call, not after it.
//
// One ledger per call (paid-call.ts): when the meter records a call
// (`recorded`), the caller writes nothing to the legacy credit/word ledgers;
// when it does not (meter off), the legacy guards and ledgers stay the record.
import type { AquillaDb } from '../../../../db/shim/postgres'
import type { Env } from '../../types'
import { readProviderCostCents, type CostRail } from '../../../../db/shared/billing-cost'
import { admitPaidCall, paidCallMeterMode, type PaidCallRefusal } from './paid-call'
import { openRouterEstimate, releaseChatUsage, settleChatUsage } from './chat-usage'

/** Who pays for a call. `orgId` null is a project with no org: with the meter
 *  off it keeps the platform ceiling and the house key, as before T6; with
 *  the meter on it is refused (there is no plan to bill).
 *  `userId` null is the system user — background work with no live person. */
export interface PaidScope {
  orgId: number | null
  userId: number | null
  projectId: string | null
  rail: CostRail
}

/** What the call can cost at most: prompt size and the output cap. */
export interface LlmBound { model: string; promptChars: number; maxOutputTokens: number }

/** The worker env, partial so a background job can pass what it holds. */
export type PaidLlmEnv = Partial<Env>

export interface PaidLlmCall {
  ok: true
  /** The key to send. Never read OPENROUTER_API_KEY directly after admission. */
  apiKey: string
  /** The meter reserved this call: it settles on the weekly ledger, and the
   *  caller must not also write the legacy credit/word ledgers. */
  recorded: boolean
  /** Settle from an OpenRouter body (`usage.cost`, `id`). Returns the raw cost
   *  in cents when the body carried one. Never throws: a missing cost keeps the
   *  reservation held for reconciliation, never a guessed zero. */
  settleFrom(body: unknown): Promise<number | undefined>
  /** Only when the provider proved no generation ran. Never throws. */
  release(): Promise<void>
}

export type PaidLlmAdmission = PaidLlmCall | PaidCallRefusal

/** The env admitPaidCall reads. A background job passes a partial env and
 *  its own connection; derive rather than spread, because a run-scoped env
 *  inherits its secrets (agent.ts runScopedEnv). */
function callEnvOf(env: PaidLlmEnv, db?: AquillaDb): Env {
  return Object.assign(Object.create(env) as Env, db ? { AQUILLA_PG: db } : {})
}

/** True when the legacy credit/word guards and ledgers are this request's
 *  record (meter off). Decided once per request, before any call admits. */
export function legacyLedgers(env: PaidLlmEnv, requestUrl?: string): boolean {
  return paidCallMeterMode(callEnvOf(env), requestUrl) === 'off'
}

/** Admit one OpenRouter call. A refusal is returned, never thrown, so each
 *  route can answer it in its own shape (`c.json(r.body, r.status)`).
 *  `db` is the connection the caller holds (a background job owns its own). */
export async function admitLlmCall(
  db: AquillaDb, env: PaidLlmEnv, scope: PaidScope, bound: LlmBound, opts: { requestUrl?: string } = {},
): Promise<PaidLlmAdmission> {
  const callEnv = callEnvOf(env, db)
  const gate = await admitPaidCall(callEnv, {
    orgId: scope.orgId ?? 0, userId: scope.userId, projectId: scope.projectId, rail: scope.rail,
    requestUrl: opts.requestUrl, estimate: openRouterEstimate(callEnv, bound),
  })
  if (!gate.ok) return gate
  const { usage } = gate
  return {
    ok: true, apiKey: gate.apiKey, recorded: usage !== undefined,
    async settleFrom(body) {
      if (usage) await settleChatUsage(callEnv, usage, body)
      return costOf(body)
    },
    async release() {
      if (usage) await releaseChatUsage(callEnv, usage)
    },
  }
}

function costOf(body: unknown): number | undefined {
  try { return readProviderCostCents(body) } catch { return undefined }
}

/** The project's org, or null for an org-less project. */
export async function projectOrgId(db: AquillaDb, projectId: string): Promise<number | null> {
  const row = await db.prepare('SELECT org_id FROM projects WHERE id = ?').bind(projectId)
    .first<{ org_id: number | string | null }>()
  return row?.org_id == null ? null : Number(row.org_id)
}

/** Thrown by helpers that cannot return a Response, so the route can answer
 *  the refusal with its own status and body. */
export class LlmRefusedError extends Error {
  constructor(readonly refusal: PaidCallRefusal) {
    super(`AI call refused: ${refusal.body.error}`)
    this.name = 'LlmRefusedError'
  }
}
