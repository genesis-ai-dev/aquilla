// Phase 2c-β: thin client (AD-3 v1) — fetch ProjectRecord from auth-worker
// on demand, with no IDB cache fallback.
//
// Pre-Phase 2c the hook hydrated the local IDB record first and then merged
// the server response on top. AD-3 v1's contract is "reads on demand";
// local caching is a v2 progressive-caching concern. v1 thin client: a
// cache miss surfaces as `isError`, and the dashboard / workspace render
// their "not yet" states from there.
//
// `project_settings` (the synced subset — sourceLanguage, targetLanguage,
// systemPrompt, rules, healthSettings, validation counts) continues to
// overlay on top of the server-side ProjectRecord; that's the canonical
// path for those keys.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { minimalProjectRecord, resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { buildCompletionSettings } from "@/hooks/useCompletionSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { getProject } from "@/lib/store/project-index"

/**
 * Overlay synced project-wide settings onto the server-returned ProjectRecord.
 * Mutates a shallow copy — never the input.
 */
function overlaySettings(record: ProjectRecord, settings: ProjectWideSettings): ProjectRecord {
  let next: ProjectRecord | null = null
  const draft = () => {
    next ??= { ...record }
    return next
  }
  const assign = <K extends keyof ProjectRecord>(key: K, value: ProjectRecord[K] | null | undefined) => {
    if (value == null) return
    if (record[key] === value) return
    draft()[key] = value
  }
  assign("sourceLanguage", settings.sourceLanguage)
  assign("targetLanguage", settings.targetLanguage)
  // AQU-538: the lane registry must reach the workspace or the LaneSwitcher
  // never renders (found by the add-target-language e2e journey).
  assign("targetLanes", settings.targetLanes)
  // AQU-601: archived-lane markers overlay alongside the registry so the
  // workspace switcher can hide archived lanes by default.
  assign("archivedLanes", settings.archivedLanes)
  if (settings.systemPrompt != null) {
    if (record.completionSettings?.systemPrompt !== settings.systemPrompt) {
      draft().completionSettings = buildCompletionSettings(
        record.completionSettings,
        { systemPrompt: settings.systemPrompt },
      )
    }
  }
  assign("rules", settings.rules)
  assign("rulePenalties", settings.rulePenalties)
  assign("algorithmicChecks", settings.algorithmicChecks)
  assign("terminology", settings.terminology)
  assign("livingMemoryEntries", settings.livingMemoryEntries)
  assign("translationBrief", settings.translationBrief)
  assign("validationCount", settings.validationCount)
  assign("validationCountAudio", settings.validationCountAudio)
  assign("validationRoleFloor", settings.validationRoleFloor)
  assign("validationNamedUsers", settings.validationNamedUsers)
  assign("allowSelfValidation", settings.allowSelfValidation)
  assign("bibleResourcesEnabled", settings.bibleResourcesEnabled)
  assign("draftContext", settings.draftContext)
  // AQU-646 SUB-53: the Media lens reads this to decide whether to draw the
  // timeline against the imported file's clock or lay the verses out end to end.
  assign("audioTimingMode", settings.audioTimingMode)
  // AQU-634: USFM front-matter opt-out must reach the workspace so ImportDialog
  // and the target-import panel drop front matter when it's on.
  assign("importExcludeFrontMatter", settings.importExcludeFrontMatter)
  if (settings.ttsSettings != null) {
    // Server carries voice profiles (no apiKey); keep any device-local apiKey.
    const merged = { ...record.ttsSettings, ...settings.ttsSettings }
    if (JSON.stringify(record.ttsSettings ?? {}) !== JSON.stringify(merged)) {
      draft().ttsSettings = merged
    }
  }
  return next ?? record
}

async function overlayDeviceLocalSettings(record: ProjectRecord): Promise<ProjectRecord> {
  let local: ProjectRecord | undefined
  try {
    local = await getProject(record.id)
  } catch (err) {
    console.warn("[useProject] failed to read device-local project cache", err)
    return record
  }
  if (!local?.completionSettings) return record
  return {
    ...record,
    completionSettings: local.completionSettings,
  }
}

export type ProjectLoadStatus =
  | "loading"
  | "ready"
  | "not-found"    // server returned 404 — project doesn't exist
  | "forbidden"    // server returned 403 — project exists but this account has no access (AQU-346)
  | "unreachable"  // network error or 5xx — server is down, not a missing project
  | "no-session"   // no jwt available; can't fetch

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [status, setStatus] = useState<ProjectLoadStatus>("loading")
  // AQU-334: the caller's role as returned by THIS load's GET /:projectId (or
  // its list-endpoint fallback) — always populated together with `project` on
  // a successful resolve. Kept separate from `project.syncRole` because that
  // field is an intentionally stale-tolerant cache (see its doc comment:
  // "stale values are tolerable — server re-validates on every archive
  // call"), stamped independently by any /sync-token round-trip anywhere in
  // the workspace (see ProjectWorkspace's onRole -> patchProject(IDB)). A
  // client-only UI gate like the Setup checklist has no server re-validation
  // on its guarded actions (SWARM-TODO in RoleGatedStep.tsx), so it must not
  // key off a value that's allowed to be missing or behind. `roleLevel` here
  // is the fresh, guaranteed-non-null value from the resolve that just ran.
  const [roleLevel, setRoleLevel] = useState<number | null>(null)
  // AQU-507: the project's designated PM from THIS load's resolve. null =
  // unassigned or not-yet-resolved; the overview's PM card reads it and
  // refresh()es after an assignment.
  const [pm, setPm] = useState<{ id: number; username: string } | null>(null)
  const hasLoaded = useRef(false)
  const { session, loading: sessionLoading } = useFrontierSession()

  const refresh = useCallback(() => {
    if (!hasLoaded.current) setStatus("loading")

    // The session store hydrates asynchronously on first load. Until it
    // resolves, `session` is null but that does NOT mean "no session" — bailing
    // to "no-session" here is what made the "not on this device" message flash
    // on every load. Stay in "loading"; the effect re-runs once hydration
    // finishes (sessionLoading flips false) and we resolve for real.
    if (sessionLoading) {
      setStatus("loading")
      return () => {}
    }

    let cancelled = false
    ;(async () => {
      if (!session?.jwt) {
        if (cancelled) return
        setProject(null)
        setRoleLevel(null)
        setStatus("no-session")
        hasLoaded.current = true
        return
      }
      const result = await resolveCloudProjectResult(projectId, session.jwt)
      if (cancelled) return
      if (!result.ok) {
        setProject(null)
        setRoleLevel(null)
        setPm(null)
        // AQU-346: "forbidden" (403 — access revoked / never granted) renders
        // a clean "you no longer have access" state, distinct from a
        // genuinely missing project.
        setStatus(
          result.reason === "unreachable"
            ? "unreachable"
            : result.reason === "forbidden"
              ? "forbidden"
              : "not-found",
        )
        hasLoaded.current = true
        return
      }
      const hydrated = await overlayDeviceLocalSettings(minimalProjectRecord(result.project))
      if (cancelled) return
      setProject(hydrated)
      setRoleLevel(result.project.role.level)
      setPm(result.project.pm ?? null)
      setStatus("ready")
      hasLoaded.current = true
    })()

    return () => { cancelled = true }
  }, [projectId, session?.jwt, sessionLoading])

  useEffect(() => {
    const cleanup = refresh()
    return cleanup
  }, [refresh])

  // Overlay synced settings (server-authoritative project-wide fields) onto
  // the hydrated record so existing consumers see merged values without any
  // per-callsite changes.
  const { settings: syncedSettings, patch: patchSettings } = useProjectSettings(projectId, roleLevel)
  const overlaid = useMemo(
    () => project ? overlaySettings(project, syncedSettings) : null,
    [project, syncedSettings],
  )

  return {
    project: overlaid,
    status,
    loading: status === "loading",
    /** True when the project is not accessible (403/404). Use `status === "unreachable"`
     *  to distinguish server-down from a genuinely missing/forbidden project. */
    isError: status === "not-found" || status === "forbidden",
    /** True when the server could not be reached (network error / 5xx). Shows
     *  "Can't reach the server" rather than "project not found". */
    isUnreachable: status === "unreachable",
    /** AQU-334: the caller's role from THIS load's resolve, fresh every time
     *  (not the stale-tolerant `project.syncRole` cache). null only when the
     *  project hasn't resolved a server role at all (loading, or genuinely
     *  unsynced/local-only). Prefer this over `project.syncRole?.level` for
     *  any gate that isn't itself server-revalidated. */
    roleLevel,
    /** AQU-507: the project's designated PM (null = unassigned / unresolved). */
    pm,
    refresh,
    /** Persist project-wide settings (incl. synced voice profiles) to the server. */
    patchSettings,
  }
}
