import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject, patchProject, updateProject } from "@/lib/store/project-index"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { minimalProjectRecord, resolveCloudProject } from "@/lib/sync/cloud-projects"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { buildCompletionSettings } from "@/hooks/useCompletionSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/**
 * Overlay synced project-wide settings onto the IDB-cached ProjectRecord.
 * Server fields win for keys it has set; local fields outside the synced
 * subset (endpoint, apiKey, model/maxTokens/temperature, audio strategy,
 * etc.) are untouched. Mutates a shallow copy — never the input.
 */
function overlaySettings(record: ProjectRecord, settings: ProjectWideSettings): ProjectRecord {
  const next: ProjectRecord = { ...record }
  if (settings.sourceLanguage != null) next.sourceLanguage = settings.sourceLanguage
  if (settings.targetLanguage != null) next.targetLanguage = settings.targetLanguage
  if (settings.systemPrompt != null) {
    // buildCompletionSettings fills required fields (endpoint, model, etc.)
    // when the local record has no completionSettings yet — without it, an
    // overlay containing only systemPrompt left endpoint undefined and
    // crashed resolveProvider on the next render (white-screen on project
    // load for fresh devices / projects synced from another user).
    next.completionSettings = buildCompletionSettings(
      record.completionSettings,
      { systemPrompt: settings.systemPrompt },
    )
  }
  if (settings.rules != null) next.rules = settings.rules
  if (settings.rulePenalties != null) next.rulePenalties = settings.rulePenalties
  if (settings.healthSettings != null) next.healthSettings = settings.healthSettings
  if (settings.validationCount != null) next.validationCount = settings.validationCount
  if (settings.validationCountAudio != null) next.validationCountAudio = settings.validationCountAudio
  return next
}

export type ProjectLoadStatus =
  | "loading"
  | "ready"
  | "not-found" // server returned 403/404, or unreachable while signed-out
  | "no-session" // no jwt to fetch from server and no IDB copy

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [status, setStatus] = useState<ProjectLoadStatus>("loading")
  const hasLoaded = useRef(false)
  const { session } = useFrontierSession()

  const refresh = useCallback(() => {
    // Only show the loading state on the first fetch. Subsequent refreshes
    // (e.g. after sync) keep the stale project visible so the editor doesn't
    // unmount — which would reset scroll position and Y.Doc bindings.
    if (!hasLoaded.current) setStatus("loading")

    let cancelled = false
    ;(async () => {
      const cached = await getProject(projectId)
      if (cancelled) return

      // If we have a cloud-hydrated record (syncRole set) with an empty
      // files list, treat it as a stale stub and refresh from the server.
      // Earlier hydrations produced these before the list endpoint returned
      // files inline. Also catches the legitimate "brand new empty project"
      // case — extra fetch per mount is acceptable.
      const isStaleStub = Boolean(
        cached && cached.syncRole && (cached.files?.length ?? 0) === 0
      )

      // Surface the cached row immediately even when we're going to refresh
      // it from the server. Previously a stale-stub silently waited on the
      // network round-trip, which on a slow connection or worker cold-start
      // left the workspace blank for ~30s; far better to render whatever
      // local state we have and patch it in once the server replies.
      if (cached) {
        setProject(cached)
        setStatus("ready")
        hasLoaded.current = true
      }

      if (cached && !isStaleStub) return

      // IDB miss (or stale stub) — try the server so a pasted URL resolves
      // on a fresh device and stubs get backfilled with their file list.
      if (!session?.jwt) {
        if (!cached) {
          setProject(null)
          setStatus("no-session")
          hasLoaded.current = true
        }
        return
      }
      const state = await resolveCloudProject(projectId, session.jwt)
      if (cancelled) return
      if (!state) {
        if (!cached) {
          setProject(null)
          setStatus("not-found")
          hasLoaded.current = true
        }
        return
      }
      const hydrated = minimalProjectRecord(state)
      // Merge instead of overwrite: a previous run on this device may have
      // captured sourceLanguage / targetLanguage / completionSettings / etc.
      // that the server doesn't store. Server fields (name, syncRole, archive
      // metadata, the file list when it's non-empty) win; everything else is
      // preserved from local IDB. This is the resilience guarantee — if IDB
      // gets cleared we fall back to server-known fields, but we never wipe
      // local state we still have.
      const merged = await patchProject(projectId, (existing) => ({
        ...existing,
        name: hydrated.name,
        syncRole: hydrated.syncRole ?? existing.syncRole,
        // Prefer server file list when local is empty (fresh device or stub);
        // otherwise keep local — server's file list is metadata-only and
        // local IDB has the actual cell counts.
        files: existing.files.length > 0 ? existing.files : hydrated.files,
        ...(hydrated.deletedAt
          ? { deletedAt: hydrated.deletedAt, deletedBy: hydrated.deletedBy }
          : {}),
      })) ?? null
      if (!merged) {
        // No prior IDB row → write the fresh stub.
        await updateProject(hydrated)
      }
      if (cancelled) return
      setProject(merged ?? hydrated)
      setStatus("ready")
      hasLoaded.current = true
    })()

    return () => { cancelled = true }
  }, [projectId, session?.jwt])

  useEffect(() => {
    const cleanup = refresh()
    return cleanup
  }, [refresh])

  // Overlay synced settings (server-authoritative project-wide fields) onto
  // the IDB record so existing consumers see merged values without any
  // per-callsite changes. The synced subset is languages, system prompt,
  // rules, health settings, validation counts. Device-local fields like
  // completionSettings.endpoint and apiKey are never affected by this.
  const roleLevel = project?.syncRole?.level ?? null
  const { settings: syncedSettings } = useProjectSettings(projectId, roleLevel)
  const overlaid = project ? overlaySettings(project, syncedSettings) : null

  return { project: overlaid, status, loading: status === "loading", refresh }
}
