// The one AI entitlement check — AQU-2061 (unified billing T4, spec §3.1, §5.3,
// §5.4). Every billable AI call passes through checkAiEntitlement (or the
// paidFetch wrapper around it) before it reaches a provider. Shared by both
// workers, like ai-spend-ceiling.ts, so it imports nothing from either.
//
// Decisions, in this order:
//   1. Resolve the org's plan (db/shared/org-plan.ts). Every org has one.
//   2. BYOK: the org has its own key for this provider → mode `byok`. Use the
//      org's key; no allowance, no platform ceiling (it is not our money).
//   3. Enterprise with a current contract → `unmetered`: recorded, never
//      refused on allowance.
//   4. Otherwise (Free / Team) → `metered`: reserve against the weekly
//      allowance. Nothing new starts at 100%; a bounded call may finish up to 105%.
//   5. The platform spend ceiling applies to `metered` and `unmetered`.
//
// It returns the provider key to use, so a route cannot fall back to the house
// key by accident.
import type { AquillaDb } from '../shim/postgres'
import type { CostRail } from './billing-cost'
import { AI_SPEND_CEILING_MESSAGE, checkAiSpendCeiling, type AiSpendCeilingEnv } from './ai-spend-ceiling'
import { resolveOrgPlan, type OrgTier } from './org-plan'
import {
  admitWorkspaceUsage, releaseWorkspaceUsage, settleWorkspaceUsage,
  type UsageDecision, type UsageMode,
} from './workspace-usage'

/** BILLING_METER_MODE (spec §5.4). One switch for every paid path.
 *  - off: no reservation and no row; the platform ceiling still applies.
 *  - shadow: every row is written; an over-limit call is stored as
 *    `would_block` and proceeds. Never refuses on allowance.
 *  - enforce: an over-limit call is refused with 402.
 */
export type MeterMode = 'off' | 'shadow' | 'enforce'
const METER_MODES: readonly MeterMode[] = ['off', 'shadow', 'enforce']

/** Unset is `off` until the shadow rollout (T13) sets it. A value that is set
 * but unknown (a typo such as "enforced") must not silently switch the meter
 * off, so it degrades to `shadow`: everything recorded, nothing refused. */
export function meterMode(env: { BILLING_METER_MODE?: string }): MeterMode {
  const raw = env.BILLING_METER_MODE?.trim().toLowerCase()
  if (!raw) return 'off'
  if ((METER_MODES as readonly string[]).includes(raw)) return raw as MeterMode
  console.warn(`[ai-entitlement] BILLING_METER_MODE="${env.BILLING_METER_MODE}" is not off|shadow|enforce; using shadow`)
  return 'shadow'
}

/** Providers a paid call can reach. */
export type AiProvider = 'openrouter' | 'gemini' | 'inworld' | 'modal'
/** Spec Q9: customers may bring OpenRouter and Gemini keys. */
const BYOK_PROVIDERS: readonly AiProvider[] = ['openrouter', 'gemini']
/** Spec Q9: GPU (Modal) and sandbox (Cloudflare containers) cannot run on a
 *  customer key, so they stay metered even for a BYOK org. */
const METERED_ONLY_RAILS: readonly CostRail[] = ['gpu', 'sandbox']

const HOUSE_KEY_ENV = {
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  inworld: 'INWORLD_API_KEY',
  modal: 'MODAL_TOKEN',
} as const satisfies Record<AiProvider, string>

export interface AiEntitlementEnv extends AiSpendCeilingEnv {
  BILLING_METER_MODE?: string
  OPENROUTER_API_KEY?: string
  GEMINI_API_KEY?: string
  INWORLD_API_KEY?: string
  MODAL_TOKEN?: string
}

export interface ProviderKey {
  provider: AiProvider
  /** `house` is the platform's key; `org` is the customer's own (BYOK). */
  source: 'house' | 'org'
  apiKey: string
}

/** Org key storage is AQU-2015 (not built yet). Routes and tests inject a
 *  lookup; the default finds no key, so every org uses the house key. */
export type ByokKeyLookup = (db: AquillaDb, orgId: number, provider: AiProvider) => Promise<string | null>
export const noByokKeys: ByokKeyLookup = async () => null

export interface AiEntitlementRequest {
  orgId: number
  /** null is the system: background work with no live user. */
  userId: number | null
  projectId?: string | null
  rail: CostRail
  provider: AiProvider
  /** Server-calculated upper bound on raw provider cost, in cents. */
  estimateRawCents: number
  /** Idempotency key. A replay is refused (409); it never authorizes a second call. */
  requestId: string
}

export interface AiEntitlementDeps {
  byokKeys?: ByokKeyLookup
  now?: Date
  /** false: check plan, key and ceiling but reserve nothing (`recorded` is
   *  false). For a multi-call run (agent, autopilot) that checks once at the
   *  start and then reserves each provider call on its own. Default true. */
  reserve?: boolean
  /** The house credential when a provider has one secret per service rather
   *  than one account key (Modal: OMNI_SHARED_SECRET, DIARIZATION_SHARED_SECRET,
   *  SEED_VC_TOKEN). Replaces the HOUSE_KEY_ENV lookup; never used for BYOK. */
  houseKey?: string
}

export type AiEntitlementReason =
  | 'ai_allowance_exhausted' | 'ai_spend_ceiling_reached' | 'provider_unconfigured' | 'duplicate_request'

/** The client contract (spec §5.3): 402 is the user's allowance; 503 is ours
 *  (platform ceiling, missing house key); 409 is a replayed request id. */
export interface AiEntitlementRefusal {
  ok: false
  status: 402 | 409 | 503
  reason: AiEntitlementReason
  body: {
    error: AiEntitlementReason
    message?: string
    tier?: OrgTier
    resetsAt?: string
    canUpgrade?: boolean
    canByok?: boolean
  }
}

export interface AiEntitlementGrant {
  ok: true
  mode: UsageMode
  /** `would_block` only in shadow mode; the call still proceeds. */
  decision: UsageDecision
  tier: OrgTier
  key: ProviderKey
  /** false in `off` mode: nothing was reserved, settle/release are no-ops. */
  recorded: boolean
  /** Record actual raw provider cost (cents). Never hides an overrun. */
  settle(actualRawCents: number, providerRef?: string): Promise<void>
  /** Only when no provider work started, or the provider proves no charge. */
  release(): Promise<void>
}

export type AiEntitlement = AiEntitlementGrant | AiEntitlementRefusal

function refusal(status: AiEntitlementRefusal['status'], reason: AiEntitlementReason,
  extra: Omit<AiEntitlementRefusal['body'], 'error'> = {}): AiEntitlementRefusal {
  return { ok: false, status, reason, body: { error: reason, ...extra } }
}

export async function checkAiEntitlement(
  db: AquillaDb, env: AiEntitlementEnv, request: AiEntitlementRequest, deps: AiEntitlementDeps = {},
): Promise<AiEntitlement> {
  const now = deps.now ?? new Date()
  const mode = meterMode(env)
  // 1. Plan.
  const plan = await resolveOrgPlan(db, request.orgId, now)
  if (!plan) throw new Error('AI entitlement org does not exist')
  const byokAllowed = BYOK_PROVIDERS.includes(request.provider) && !METERED_ONLY_RAILS.includes(request.rail)

  // 2. BYOK: the customer's key, no allowance and no platform ceiling.
  const orgKey = byokAllowed ? await (deps.byokKeys ?? noByokKeys)(db, request.orgId, request.provider) : null
  let key: ProviderKey
  if (orgKey) {
    key = { provider: request.provider, source: 'org', apiKey: orgKey }
  } else {
    // 5. The ceiling protects the house keys, so it runs in every meter mode,
    // shadow included: it is the platform kill switch, not an allowance.
    const ceiling = await checkAiSpendCeiling(db, env, request.rail)
    if (!ceiling.ok) return refusal(503, 'ai_spend_ceiling_reached', { message: AI_SPEND_CEILING_MESSAGE })
    const apiKey = deps.houseKey ?? env[HOUSE_KEY_ENV[request.provider]]
    if (!apiKey) return refusal(503, 'provider_unconfigured')
    key = { provider: request.provider, source: 'house', apiKey }
  }
  // 3/4. Enterprise is unmetered; Free and Team are metered.
  const usageMode: UsageMode = orgKey ? 'byok' : plan.weeklyAllowanceUnits === null ? 'unmetered' : 'metered'

  if (mode === 'off' || deps.reserve === false) {
    return { ok: true, mode: usageMode, decision: 'allow', tier: plan.tier, key, recorded: false,
      settle: async () => {}, release: async () => {} }
  }

  const admitted = await admitWorkspaceUsage(db, {
    orgId: request.orgId, requestId: request.requestId, userId: request.userId,
    projectId: request.projectId ?? null, rail: request.rail,
    maxRawCostCents: request.estimateRawCents, byok: orgKey !== null,
    refuseOverLimit: mode === 'enforce',
  }, now)
  if (!admitted.admitted) {
    return refusal(402, 'ai_allowance_exhausted', {
      tier: plan.tier, resetsAt: plan.period.end,
      canUpgrade: plan.tier === 'free', canByok: byokAllowed,
    })
  }
  if (!admitted.created) return refusal(409, 'duplicate_request')
  const { orgId, requestId } = request
  return {
    // The row's mode is authoritative: the plan was re-read under the org lock.
    ok: true, mode: admitted.request.mode, decision: admitted.request.decision, tier: plan.tier, key, recorded: true,
    settle: async (actualRawCents, providerRef) => {
      await settleWorkspaceUsage(db, orgId, requestId, actualRawCents, providerRef)
    },
    release: async () => { await releaseWorkspaceUsage(db, orgId, requestId) },
  }
}

/** Reserve → call → settle; release if the call throws.
 *
 * `call` gets the key the check chose. `cost` reads the actual raw cost in
 * cents from the result (for OpenRouter: readProviderCostCents, which reads
 * `usage.cost`; for audio/GPU: measured units × rate card). When `cost` throws
 * the spend is unknown: the reservation stays held for reconciliation and the
 * result is still returned, because the provider work already happened.
 */
export async function paidFetch<T>(
  db: AquillaDb, env: AiEntitlementEnv, request: AiEntitlementRequest,
  call: (key: ProviderKey) => Promise<T>,
  cost: (result: T) => number | Promise<number>,
  deps: AiEntitlementDeps & { providerRef?: (result: T) => string | undefined } = {},
): Promise<{ ok: true; result: T; entitlement: AiEntitlementGrant } | AiEntitlementRefusal> {
  const entitlement = await checkAiEntitlement(db, env, request, deps)
  if (!entitlement.ok) return entitlement
  let result: T
  try {
    result = await call(entitlement.key)
  } catch (err) {
    await entitlement.release().catch(releaseErr =>
      console.error('[ai-entitlement] release failed after a provider error:', releaseErr))
    throw err
  }
  let actual: number | undefined
  try { actual = await cost(result) } catch (err) {
    console.error(`[ai-entitlement] cost unknown for ${request.rail} ${request.requestId}; reservation held:`, err)
  }
  if (actual !== undefined) await entitlement.settle(actual, deps.providerRef?.(result))
  return { ok: true, result, entitlement }
}
