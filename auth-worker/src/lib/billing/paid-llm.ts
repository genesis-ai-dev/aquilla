// AQU-2063 (unified billing T6): the auth-worker OpenRouter paths that were
// never on the weekly meter — DraftCells, brief summary, the import sandbox's
// parser model, knowledge indexing, Monday analyze and the tools builder (spec
// §3.2 rows 10, 11, 12, 23, 24, 25). Each provider call goes through
// checkAiEntitlement before it spends and settles the provider's own
// `usage.cost` after, one ledger row per call.
//
// These paths are non-streaming and may make several calls per job (research
// then draft, one call per summary batch, a parse retry), so each call admits
// on its own: a job that crosses 100% stops at its next call, not after it.
import type { AquillaDb } from '../../../../db/shim/postgres'
import {
  checkAiEntitlement, meterMode, type AiEntitlementDeps, type AiEntitlementEnv, type AiEntitlementRefusal,
} from '../../../../db/shared/ai-entitlement'
import { AI_SPEND_CEILING_MESSAGE, checkAiSpendCeiling } from '../../../../db/shared/ai-spend-ceiling'
import { readProviderCostCents, type CostRail } from '../../../../db/shared/billing-cost'
import { validProviderRef } from '../../../../db/shared/workspace-usage'
import { boundRequestCostCents, readRateCard } from './rate-card'

/** Who pays for a call. `orgId` null is a project with no org: there is no
 *  ledger to write, so only the platform ceiling applies (as before T6).
 *  `userId` null is the system user — background work with no live person. */
export interface PaidScope {
  orgId: number | null
  userId: number | null
  projectId: string | null
  rail: CostRail
}

/** What the call can cost at most: prompt size and the output cap. */
export interface LlmBound { model: string; promptChars: number; maxOutputTokens: number }

/** Reservation used when the rate card cannot price the model (card
 *  unreachable, model missing). It only holds the slot; settlement replaces it
 *  with the provider's reported cost. These paths ran unmetered before T6, so
 *  a pricing outage must not take them down. */
export const UNPRICED_BOUND_CENTS = 50

export interface PaidLlmCall {
  ok: true
  /** The key to send. Never read OPENROUTER_API_KEY directly after admission. */
  apiKey: string
  /** `org` when the org brought its own OpenRouter key (BYOK). */
  source: 'house' | 'org'
  /** Settle from an OpenRouter body (`usage.cost`, `id`). Returns the raw cost
   *  in cents when the body carried one. Never throws: a missing cost keeps the
   *  reservation held for reconciliation, never a guessed zero. */
  settleFrom(body: unknown): Promise<number | undefined>
  /** No provider work started, or the provider proved no charge. Never throws. */
  release(): Promise<void>
}

export type PaidLlmAdmission = PaidLlmCall | AiEntitlementRefusal

/** What admission reads from the worker env: the meter mode, the house keys,
 *  the ceiling, and the OpenRouter base for the rate card. */
export interface PaidLlmEnv extends AiEntitlementEnv { OPENROUTER_BASE_URL?: string }

async function estimateCents(env: PaidLlmEnv, bound: LlmBound): Promise<number> {
  // `off` reserves nothing, so do not spend a rate-card fetch on it.
  if (meterMode(env) === 'off') return UNPRICED_BOUND_CENTS
  try {
    return boundRequestCostCents(await readRateCard(env), bound)
  } catch (err) {
    console.warn(`[billing] no price for ${bound.model}; reserving ${UNPRICED_BOUND_CENTS}¢:`, err instanceof Error ? err.message : err)
    return UNPRICED_BOUND_CENTS
  }
}

/** Admit one OpenRouter call. A refusal is returned, never thrown, so each
 *  route can answer it in its own shape (`c.json(r.body, r.status)`). */
export async function admitLlmCall(
  db: AquillaDb, env: PaidLlmEnv, scope: PaidScope, bound: LlmBound, deps: AiEntitlementDeps = {},
): Promise<PaidLlmAdmission> {
  const house = env.OPENROUTER_API_KEY ?? ''
  if (scope.orgId === null) {
    const ceiling = await checkAiSpendCeiling(db, env, scope.rail)
    if (!ceiling.ok) {
      return { ok: false, status: 503, reason: 'ai_spend_ceiling_reached',
        body: { error: 'ai_spend_ceiling_reached', message: AI_SPEND_CEILING_MESSAGE } }
    }
    return { ok: true, apiKey: house, source: 'house', settleFrom: async body => costOf(body), release: async () => {} }
  }
  const grant = await checkAiEntitlement(db, env, {
    orgId: scope.orgId, userId: scope.userId, projectId: scope.projectId, rail: scope.rail,
    provider: 'openrouter', estimateRawCents: await estimateCents(env, bound),
    requestId: crypto.randomUUID(),
  }, deps)
  if (!grant.ok) return grant
  return {
    ok: true, apiKey: grant.key.apiKey, source: grant.key.source,
    async settleFrom(body) {
      const cents = costOf(body)
      if (cents === undefined) {
        console.warn(`[billing] ${scope.rail} call returned no usage.cost; reservation held for reconciliation`)
        return undefined
      }
      const id = (body as { id?: unknown } | null)?.id
      try { await grant.settle(cents, validProviderRef(id) ? id : undefined) }
      catch (err) { console.error(`[billing] ${scope.rail} settle failed; reservation held:`, err) }
      return cents
    },
    async release() {
      try { await grant.release() }
      catch (err) { console.error(`[billing] ${scope.rail} release failed; reservation held:`, err) }
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
  constructor(readonly refusal: AiEntitlementRefusal) {
    super(`AI call refused: ${refusal.reason}`)
    this.name = 'LlmRefusedError'
  }
}
