// AQU-2066 (unified billing T9): container time on the `sandbox` rail (spec
// §3.2 rows 12 and 26, decision Q3). Cloudflare bills a container for every
// 10 ms it runs, so the meter reserves the longest the work can take, then
// settles the seconds it measured, priced from the Containers price card.
// The sandbox cannot run on a customer key, so these rows stay metered even
// for an org that brings its own keys (ai-entitlement.ts METERED_ONLY_RAILS).
// The pool caps (agent-worker/src/pool.ts) are unchanged: they bound how many
// containers run at once; this bounds how much a workspace spends.
import type { AquillaDb } from '../../../../db/shim/postgres'
import {
  checkAiEntitlement, type AiEntitlementEnv, type AiEntitlementRefusal,
} from '../../../../db/shared/ai-entitlement'
import { AI_SPEND_CEILING_MESSAGE, checkAiSpendCeiling } from '../../../../db/shared/ai-spend-ceiling'
import type { PaidScope } from './paid-llm'

/** Cloudflare Containers price card, USD, for the sandbox's instance type
 *  (agent-worker/wrangler.toml `instance_type = "standard-1"`: ½ vCPU, 4 GiB,
 *  8 GB). Source: developers.cloudflare.com/containers/platform/pricing
 *  (checked 2026-10-21). CPU is billed on active use only; pricing it as fully
 *  busy makes this an upper bound. The plan's included monthly usage is an
 *  account-level discount, not per-workspace, so it is ignored. */
export const SANDBOX_PRICE_CARD = {
  instanceType: 'standard-1',
  vcpu: 0.5,
  memoryGiB: 4,
  diskGB: 8,
  usdPerVcpuSecond: 0.000020,
  usdPerGiBSecond: 0.0000025,
  usdPerGBSecond: 0.00000007,
} as const

/** Raw cents for `seconds` of one running container. */
export function containerCents(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Container seconds must be a known nonnegative amount')
  const c = SANDBOX_PRICE_CARD
  const usdPerSecond = c.vcpu * c.usdPerVcpuSecond + c.memoryGiB * c.usdPerGiBSecond + c.diskGB * c.usdPerGBSecond
  return seconds * usdPerSecond * 100
}

export interface SandboxTimeGrant {
  ok: true
  /** Record the measured container seconds. Never throws. */
  settleSeconds(seconds: number): Promise<void>
  /** No container ran (the pool refused, the sandbox was unreachable). Never throws. */
  release(): Promise<void>
}

/** Reserve up to `maxSeconds` of container time before a container starts. */
export async function admitSandboxTime(
  db: AquillaDb, env: AiEntitlementEnv, scope: Omit<PaidScope, 'rail'>, maxSeconds: number,
): Promise<SandboxTimeGrant | AiEntitlementRefusal> {
  if (scope.orgId === null) {
    // An org-less project has no ledger; the platform ceiling still applies.
    const ceiling = await checkAiSpendCeiling(db, env, 'sandbox')
    if (!ceiling.ok) {
      return { ok: false, status: 503, reason: 'ai_spend_ceiling_reached',
        body: { error: 'ai_spend_ceiling_reached', message: AI_SPEND_CEILING_MESSAGE } }
    }
    return { ok: true, settleSeconds: async () => {}, release: async () => {} }
  }
  const grant = await checkAiEntitlement(db, env, {
    orgId: scope.orgId, userId: scope.userId, projectId: scope.projectId, rail: 'sandbox',
    provider: 'cloudflare', estimateRawCents: containerCents(maxSeconds), requestId: crypto.randomUUID(),
  })
  if (!grant.ok) return grant
  return {
    ok: true,
    async settleSeconds(seconds) {
      try { await grant.settle(containerCents(seconds)) }
      catch (err) { console.error('[billing] sandbox settle failed; reservation held:', err) }
    },
    async release() {
      try { await grant.release() }
      catch (err) { console.error('[billing] sandbox release failed; reservation held:', err) }
    },
  }
}

/** Wall-clock seconds since `startedAt` (ms). */
export function secondsSince(startedAt: number, now = Date.now()): number {
  return Math.max(0, now - startedAt) / 1000
}
