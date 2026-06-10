import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ROLE } from "@/lib/frontier/roles"
import {
  fetchOrgSettings,
  patchOrgSettings,
  postPromotionRequest,
  type OrgSettingsResponse,
  type OrgWideSettings,
  type OrgPatchResult,
  type PromotionRequestResult,
} from "@/lib/sync/org-settings"
import type { TranslationRule, PromotionRequest } from "@/lib/parsers/types"

// Floor aligned with the server's SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER (600)
// in auth-worker/src/routes/org-settings.ts. Lowering this to PROJECT_LEAD (500)
// would re-open the FRO-255 silent-divergence window (editable controls + a 403
// the user never sees) — do not change without a matching auth-worker update.
const ORG_SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

export interface UseOrgSettings {
  /** Current org settings (rules, etc). Always defined (empty when unloaded). */
  settings: OrgWideSettings
  /** Org rules shortcut. */
  orgRules: TranslationRule[]
  /** Pending promotion requests (visible to all members, acted on by maintainers). */
  promotionRequests: PromotionRequest[]
  /** True when caller's org role >= PROJECT_LEAD. Can submit promotion requests. */
  canRequestPromotion: boolean
  /** Server version, null if never fetched. */
  version: number | null
  hasFetched: boolean
  /** True when the caller's org role is >= MAINTAINER. */
  canEdit: boolean
  /** Force a re-GET. */
  refresh: () => Promise<OrgSettingsResponse | null>
  /** Patch org settings (adds/replaces top-level keys). Blocked if !canEdit —
   *  below-floor callers never apply an optimistic write. Server-forbidden and
   *  error responses roll back the optimistic write and re-fetch truth. */
  patch: (partial: OrgWideSettings) => Promise<OrgPatchResult | { kind: "blocked" }>
  /** Submit a promotion request for a project rule. Returns "duplicate" if already pending. */
  requestPromotion: (rule: TranslationRule, sourceProjectId: string) => Promise<PromotionRequestResult | { kind: "blocked" }>
}

/**
 * Fetches and manages org-level settings (rules, etc.) for the given org.
 *
 * @param orgId  Active org ID. Null/undefined = no-op, returns empty state.
 * @param orgRoleLevel  Caller's role level in this org (from useActiveOrg). Null = no membership.
 */
export function useOrgSettings(
  orgId: number | null | undefined,
  orgRoleLevel: number | null | undefined,
): UseOrgSettings {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [server, setServer] = useState<OrgSettingsResponse | null>(null)
  const [hasFetched, setHasFetched] = useState(false)

  const serverRef = useRef<OrgSettingsResponse | null>(null)
  const writeServer = useCallback((next: OrgSettingsResponse | null) => {
    serverRef.current = next
    setServer(next)
  }, [])

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  // Serialize writes to avoid version conflicts.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const runSerialized = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = writeChainRef.current.then(fn, fn)
    writeChainRef.current = next.catch(() => {})
    return next
  }, [])

  const refresh = useCallback(async (): Promise<OrgSettingsResponse | null> => {
    if (!orgId || !jwt) return null
    const got = await fetchOrgSettings(jwt, orgId)
    if (!aliveRef.current) return null
    writeServer(got)
    setHasFetched(true)
    return got
  }, [orgId, jwt, writeServer])

  useEffect(() => {
    if (!orgId) {
      writeServer(null)
      setHasFetched(false)
      return
    }
    let alive = true
    aliveRef.current = true
    void refresh().then(() => { if (!alive) return }).catch(() => {})
    return () => { alive = false }
  }, [orgId, refresh, writeServer])

  const canEdit =
    orgRoleLevel != null && orgRoleLevel >= ORG_SETTINGS_WRITE_MIN_ROLE

  const patch = useCallback(
    async (partial: OrgWideSettings): Promise<OrgPatchResult | { kind: "blocked" }> => {
      if (!orgId || !jwt) return { kind: "error" as const, status: 0, message: "no session or org" }
      if (!canEdit) return { kind: "blocked" }

      return runSerialized(async () => {
        const fresh = (await fetchOrgSettings(jwt, orgId)) ?? serverRef.current
        const baseVersion = fresh?.version ?? 0
        const merged: OrgWideSettings = { ...(fresh?.settings ?? {}), ...partial }

        // Optimistic local update.
        writeServer({
          orgId: orgId,
          settings: merged,
          version: baseVersion,
          updatedAt: fresh?.updatedAt ?? null,
          updatedBy: fresh?.updatedBy ?? null,
        })

        const result = await patchOrgSettings(jwt, orgId, merged, baseVersion)

        if (result.kind === "ok") writeServer(result.value)
        else if (result.kind === "conflict") writeServer(result.latest)
        else {
          // Forbidden (role check failed at the API layer) or error: roll back
          // the optimistic write to the pre-write snapshot, then re-fetch truth.
          // Without this the rejected value lingered until an unrelated refresh
          // (FRO-255: no silent local divergence).
          writeServer(fresh)
          void refresh()
        }
        return result
      })
    },
    [orgId, jwt, canEdit, runSerialized, writeServer, refresh],
  )

  const canRequestPromotion =
    orgRoleLevel != null && orgRoleLevel >= ROLE.PROJECT_LEAD

  const requestPromotion = useCallback(
    async (rule: TranslationRule, sourceProjectId: string): Promise<PromotionRequestResult | { kind: "blocked" }> => {
      if (!orgId || !jwt) return { kind: "error" as const, status: 0, message: "no session or org" }
      if (!canRequestPromotion) return { kind: "blocked" }
      const result = await postPromotionRequest(jwt, orgId, rule, sourceProjectId)
      // On success, refresh so pending requests panel updates immediately.
      if (result.kind === "ok") void refresh()
      return result
    },
    [orgId, jwt, canRequestPromotion, refresh],
  )

  const settings = server?.settings ?? {}
  const orgRules: TranslationRule[] = settings.rules ?? []
  const promotionRequests: PromotionRequest[] = (settings.promotionRequests as PromotionRequest[] | undefined) ?? []

  return {
    settings,
    orgRules,
    promotionRequests,
    canRequestPromotion,
    version: server ? server.version : null,
    hasFetched,
    canEdit,
    refresh,
    patch,
    requestPromotion,
  }
}
