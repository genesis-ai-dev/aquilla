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

import { useCallback, useEffect, useRef, useState } from "react"
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
  const next: ProjectRecord = { ...record }
  if (settings.sourceLanguage != null) next.sourceLanguage = settings.sourceLanguage
  if (settings.targetLanguage != null) next.targetLanguage = settings.targetLanguage
  if (settings.systemPrompt != null) {
    next.completionSettings = buildCompletionSettings(
      record.completionSettings,
      { systemPrompt: settings.systemPrompt },
    )
  }
  if (settings.rules != null) next.rules = settings.rules
  if (settings.rulePenalties != null) next.rulePenalties = settings.rulePenalties
  if (settings.algorithmicChecks != null) next.algorithmicChecks = settings.algorithmicChecks
  if (settings.terminology != null) next.terminology = settings.terminology
  if (settings.livingMemoryEntries != null) next.livingMemoryEntries = settings.livingMemoryEntries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- translationBrief is synced via ProjectWideSettings; type will be added to ProjectRecord in a follow-up
  if (settings.translationBrief != null) (next as any).translationBrief = settings.translationBrief
  if (settings.validationCount != null) next.validationCount = settings.validationCount
  if (settings.validationCountAudio != null) next.validationCountAudio = settings.validationCountAudio
  if (settings.validationRoleFloor != null) next.validationRoleFloor = settings.validationRoleFloor
  if (settings.validationNamedUsers != null) next.validationNamedUsers = settings.validationNamedUsers
  if (settings.allowSelfValidation != null) next.allowSelfValidation = settings.allowSelfValidation
  if (settings.bibleResourcesEnabled != null) next.bibleResourcesEnabled = settings.bibleResourcesEnabled
  if (settings.ttsSettings != null) {
    // Server carries voice profiles (no apiKey); keep any device-local apiKey.
    next.ttsSettings = { ...next.ttsSettings, ...settings.ttsSettings }
  }
  return next
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
  | "not-found"    // server returned 403/404 — project doesn't exist or no access
  | "unreachable"  // network error or 5xx — server is down, not a missing project
  | "no-session"   // no jwt available; can't fetch

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [status, setStatus] = useState<ProjectLoadStatus>("loading")
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
        setStatus("no-session")
        hasLoaded.current = true
        return
      }
      const result = await resolveCloudProjectResult(projectId, session.jwt)
      if (cancelled) return
      if (!result.ok) {
        setProject(null)
        setStatus(result.reason === "unreachable" ? "unreachable" : "not-found")
        hasLoaded.current = true
        return
      }
      const hydrated = await overlayDeviceLocalSettings(minimalProjectRecord(result.project))
      if (cancelled) return
      setProject(hydrated)
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
  const roleLevel = project?.syncRole?.level ?? null
  const { settings: syncedSettings, patch: patchSettings } = useProjectSettings(projectId, roleLevel)
  const overlaid = project ? overlaySettings(project, syncedSettings) : null

  return {
    project: overlaid,
    status,
    loading: status === "loading",
    /** True when the project is not accessible (403/404). Use `status === "unreachable"`
     *  to distinguish server-down from a genuinely missing/forbidden project. */
    isError: status === "not-found",
    /** True when the server could not be reached (network error / 5xx). Shows
     *  "Can't reach the server" rather than "project not found". */
    isUnreachable: status === "unreachable",
    refresh,
    /** Persist project-wide settings (incl. synced voice profiles) to the server. */
    patchSettings,
  }
}
