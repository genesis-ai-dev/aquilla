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

const ORG_SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

/** FRO-253: default export floor when org hasn't set one. Mirrors the server default. */
const EXPORT_DEFAULT_MIN_ROLE = ROLE.MAINTAINER

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
  /**
   * FRO-253: True when the caller's role meets the org's exportMinRole floor.
   * When no exportMinRole is set, defaults to MAINTAINER (600) — same as the
   * server default. Callers should hide/disable export affordances when false.
   */
  canExport: boolean
  /** The effective export floor (resolved, defaults to MAINTAINER). */
  exportMinRole: number
  /** Force a re-GET. */
  refresh: () => Promise<OrgSettingsResponse | null>
  /** Patch org settings (adds/replaces top-level keys). Blocked if !canEdit. */
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

  // FRO-253: derive canExport from the org's exportMinRole floor.
  const exportMinRole = (() => {
    const raw = server?.settings?.exportMinRole
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 100 && raw <= 700) return raw
    return EXPORT_DEFAULT_MIN_ROLE
  })()

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
        // On error/forbidden, a refresh will revert the optimistic write.
        return result
      })
    },
    [orgId, jwt, canEdit, runSerialized, writeServer],
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

  // FRO-253: canExport is true when the user's role meets the org floor.
  // Before settings load (hasFetched=false), we optimistically allow export so
  // the button isn't hidden during the initial load; the server will 403 if the
  // user doesn't actually have access.
  const canExport = !hasFetched || orgRoleLevel == null || orgRoleLevel >= exportMinRole

  return {
    settings,
    orgRules,
    promotionRequests,
    canRequestPromotion,
    version: server ? server.version : null,
    hasFetched,
    canEdit,
    canExport,
    exportMinRole,
    refresh,
    patch,
    requestPromotion,
  }
}
