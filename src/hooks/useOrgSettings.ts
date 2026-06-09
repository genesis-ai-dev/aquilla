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

// FRO-253: The WRITE gate for the exportMinRole setting itself is OWNER (700).
// This is enforced server-side (auth-worker org-settings PATCH handler).
// The client-side Settings UI enforces it via canEditExportFloor=(role>=OWNER)
// so the select is disabled for non-owners. The server remains the source of truth.

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
   * FRO-253: True when the caller's project-resolved role meets the org's exportMinRole floor.
   *
   * NON-BREAKING DEFAULT: when the org has NOT explicitly set exportMinRole, canExport is
   * always true client-side (gate nothing — pre-FRO-253 behavior; server routes keep their
   * own pre-existing MAINTAINER default). Only when exportMinRole is explicitly set in org
   * settings does this gate apply. Callers should hide/disable export affordances when false.
   *
   * ROLE COMPARED: the project-resolved role (AD-12 max-wins — org role, group grants,
   * direct project grant, creator path) passed as `projectRoleLevel`, NOT the raw org role.
   * This means a user with org VIEWER + direct project MAINTAINER grant correctly sees
   * canExport=true under a floor of MAINTAINER.
   *
   * NOTE: client-side formats (txt/md/tsv/csv/xlf/tmx/vtt) operate on already-fetched cells
   * and cannot be truly enforced client-side. The floor here gates the UI affordance and the
   * server-side USFM/bundle routes; read-API gating is explicitly out of scope (FRO-253).
   */
  canExport: boolean
  /**
   * The explicit export floor from org settings, or null when the org has NOT set one.
   * Null means "no client-side gate" (non-breaking default).
   * The effective server default (MAINTAINER=600) is preserved in the server routes
   * independently of this field.
   */
  exportMinRole: number | null
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
 * @param orgRoleLevel  Caller's org-level role (from useActiveOrg). Used for edit gating. Null = no membership.
 * @param projectRoleLevel  Caller's project-resolved role (AD-12 max-wins). Used for canExport.
 *   Falls back to orgRoleLevel when not provided (personal projects / no-org contexts).
 */
export function useOrgSettings(
  orgId: number | null | undefined,
  orgRoleLevel: number | null | undefined,
  projectRoleLevel?: number | null,
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

  // FRO-253: derive the explicit export floor from org settings.
  // null = org has NOT set it (non-breaking default: no client-side gate).
  // The server routes independently default to MAINTAINER (600) for USFM/bundle.
  const exportMinRole = (() => {
    if (!hasFetched) return null
    const raw = server?.settings?.exportMinRole
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 100 && raw <= 700) return raw
    return null // not set — no client-side gate
  })()

  // The effective role to check: project-resolved (AD-12 max-wins) when
  // available, falling back to org role for non-project contexts.
  const effectiveRoleLevel = projectRoleLevel ?? orgRoleLevel

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

  // FRO-253 (corrected): canExport logic:
  //   • Before settings are fetched (hasFetched=false): optimistically allow so the
  //     button renders; the ACTION (openExportFlow) must wait for hasFetched.
  //   • After fetch, if exportMinRole is null (not set): ALLOW — non-breaking default.
  //     Pre-FRO-253 the button had no role gate; we preserve that for orgs that
  //     haven't configured anything. Server routes gate USFM/bundle independently.
  //   • After fetch, if exportMinRole is set: compare against the project-resolved
  //     role (effectiveRoleLevel), not the raw org role.
  const canExport =
    !hasFetched ||              // optimistic pre-fetch allow
    exportMinRole === null ||   // org hasn't set a floor — no client gate
    effectiveRoleLevel == null || // no role info yet — allow (server will 403 if needed)
    effectiveRoleLevel >= exportMinRole

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
