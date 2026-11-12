// AQU-2065 (unified billing T8): the sync-worker side of checkAiEntitlement.
// TTS, voice design/publish, diarization and voice-convert bill the project's
// org through the one check (db/shared/ai-entitlement.ts), which also runs the
// platform spend ceiling these routes used to call by hand.
import {
  checkAiEntitlement, type AiEntitlementEnv, type AiEntitlementGrant, type AiProvider,
} from "../../db/shared/ai-entitlement"
import { checkAiSpendCeiling } from "../../db/shared/ai-spend-ceiling"
import type { CostRail } from "../../db/shared/billing-cost"

export interface ProjectAiCall {
  projectId: string
  userId: number | null
  rail: CostRail
  provider: AiProvider
  /** The house key for this provider, from this worker's env. Modal has no
   *  single key here: each service has its own shared secret. */
  houseKey: string | undefined
  estimateRawCents: number
  requestId: string
}

export type ProjectAiEntitlement =
  | { ok: true; orgId: number | null; grant: AiEntitlementGrant }
  | { ok: false; response: Response }

export async function projectOrgId(db: AquillaDb, projectId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT org_id FROM projects WHERE id = ?`).bind(projectId)
    .first<{ org_id: number | string | null }>()
  return row?.org_id == null ? null : Number(row.org_id)
}

/** A project with no org has no plan to meter against. It keeps today's
 *  behaviour: the platform ceiling, the house key, no row. */
function unrecordedGrant(provider: AiProvider, apiKey: string): AiEntitlementGrant {
  return {
    ok: true, mode: "metered", decision: "allow", tier: "free", recorded: false,
    key: { provider, source: "house", apiKey },
    settle: async () => {}, release: async () => {},
  }
}

export async function entitleProjectAiCall(
  db: AquillaDb, env: AiEntitlementEnv, call: ProjectAiCall,
): Promise<ProjectAiEntitlement> {
  const orgId = await projectOrgId(db, call.projectId)
  if (orgId === null) {
    const ceiling = await checkAiSpendCeiling(db, env, call.rail)
    if (!ceiling.ok) return { ok: false, response: Response.json(ceiling.body, { status: ceiling.status }) }
    if (!call.houseKey) return { ok: false, response: Response.json({ error: "provider_unconfigured" }, { status: 503 }) }
    return { ok: true, orgId, grant: unrecordedGrant(call.provider, call.houseKey) }
  }
  const result = await checkAiEntitlement(db, { ...env, ...houseKeyEnv(call.provider, call.houseKey) }, {
    orgId, userId: call.userId, projectId: call.projectId, rail: call.rail,
    provider: call.provider, estimateRawCents: call.estimateRawCents, requestId: call.requestId,
  })
  if (!result.ok) return { ok: false, response: Response.json(result.body, { status: result.status }) }
  return { ok: true, orgId, grant: result }
}

/** checkAiEntitlement reads the house key from a fixed env name per provider.
 *  Hand it the key this route actually uses. */
function houseKeyEnv(provider: AiProvider, key: string | undefined): Partial<AiEntitlementEnv> {
  if (provider === "inworld") return { INWORLD_API_KEY: key }
  if (provider === "modal") return { MODAL_TOKEN: key }
  if (provider === "gemini") return { GEMINI_API_KEY: key }
  return { OPENROUTER_API_KEY: key }
}

/** Settlement must never fail a call whose provider work already happened.
 *  A failed settle leaves the reservation held for reconciliation. */
export async function settleQuietly(grant: AiEntitlementGrant, rawCents: number, label: string): Promise<void> {
  try {
    await grant.settle(rawCents)
  } catch (err) {
    console.warn(`[billing] ${label} usage requires reconciliation`, { rawCents }, err)
  }
}

export async function releaseQuietly(grant: AiEntitlementGrant, label: string): Promise<void> {
  try {
    await grant.release()
  } catch (err) {
    console.warn(`[billing] ${label} reservation release failed`, err)
  }
}
