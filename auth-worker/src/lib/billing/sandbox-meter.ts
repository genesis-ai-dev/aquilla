// AQU-2066 (unified billing T9): container time on the `sandbox` rail (spec
// §3.2 rows 12 and 26, decision Q3). Cloudflare bills a container for every
// 10 ms it runs, so the meter reserves the longest the work can take, then
// settles the seconds it measured, priced from the Containers price card.
// The sandbox cannot run on a customer key, so these rows stay metered even
// for an org that brings its own keys (ai-entitlement.ts METERED_ONLY_RAILS).
// The pool caps (agent-worker/src/pool.ts) are unchanged: they bound how many
// containers run at once; this bounds how much a workspace spends.
import type { AquillaDb } from '../../../../db/shim/postgres'
import type { Env } from '../../types'
import { releaseWorkspaceUsage, settleWorkspaceUsage } from '../../../../db/shared/workspace-usage'
import { admitPaidCall, type PaidCallRefusal } from './paid-call'
import type { PaidLlmEnv, PaidScope } from './paid-llm'

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

/** Reserve up to `maxSeconds` of container time before a container starts.
 *  Admits through T5's admitPaidCall (paid-call.ts), so the meter-mode
 *  mapping and the org-less rule match every other paid path. */
export async function admitSandboxTime(
  db: AquillaDb, env: PaidLlmEnv, scope: Omit<PaidScope, 'rail'>, maxSeconds: number,
  opts: { requestUrl?: string } = {},
): Promise<SandboxTimeGrant | PaidCallRefusal> {
  // Derive rather than spread: a run-scoped env inherits its secrets.
  const callEnv = Object.assign(Object.create(env) as Env, { AQUILLA_PG: db })
  const gate = await admitPaidCall(callEnv, {
    orgId: scope.orgId ?? 0, userId: scope.userId, projectId: scope.projectId, rail: 'sandbox',
    provider: 'cloudflare', houseKey: env.AGENT_SANDBOX_KEY, requestUrl: opts.requestUrl,
    estimate: () => containerCents(maxSeconds),
  })
  if (!gate.ok) return gate
  const { usage } = gate
  return {
    ok: true,
    async settleSeconds(seconds) {
      if (!usage) return
      try { await settleWorkspaceUsage(db, usage.orgId, usage.requestId, containerCents(seconds)) }
      catch (err) { console.error('[billing] sandbox settle failed; reservation held:', usage, err) }
    },
    async release() {
      if (!usage) return
      try { await releaseWorkspaceUsage(db, usage.orgId, usage.requestId) }
      catch (err) { console.error('[billing] sandbox release failed; reservation held:', usage, err) }
    },
  }
}

/** Wall-clock seconds since `startedAt` (ms). */
export function secondsSince(startedAt: number, now = Date.now()): number {
  return Math.max(0, now - startedAt) / 1000
}
