// Phase 2c-β: server-first project hydration (AD-3 v1).
//
// Project identity, role, and membership come from frontier-server on demand.
// The file projection can lag behind the local import transaction in dev/E2E
// topologies where workers do not share a D1 instance, so locally known file
// refs are merged as a narrow overlay after the server record is resolved.
//
// `project_settings` (the synced subset — sourceLanguage, targetLanguage,
// systemPrompt, rules, healthSettings, validation counts) continues to
// overlay on top of the server-side ProjectRecord; that's the canonical
// path for those keys.

import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { minimalProjectRecord, resolveCloudProject } from "@/lib/sync/cloud-projects"
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
  if (settings.healthSettings != null) next.healthSettings = settings.healthSettings
  if (settings.validationCount != null) next.validationCount = settings.validationCount
  if (settings.validationCountAudio != null) next.validationCountAudio = settings.validationCountAudio
  return next
}

async function overlayLocalProjectState(record: ProjectRecord): Promise<ProjectRecord> {
  const local = await getProject(record.id).catch(() => undefined)
  if (!local) return record

  const serverFileIds = new Set(record.files.map((file) => file.id))
  const localOnlyFiles = local.files.filter((file) => !serverFileIds.has(file.id))
  const files = localOnlyFiles.length > 0
    ? [...record.files, ...localOnlyFiles]
    : record.files

  return {
    ...record,
    sourceLanguage: record.sourceLanguage || local.sourceLanguage,
    targetLanguage: record.targetLanguage || local.targetLanguage,
    completionSettings: local.completionSettings ?? record.completionSettings,
    files,
  }
}

export type ProjectLoadStatus =
  | "loading"
  | "ready"
  | "not-found"   // server returned 403/404
  | "no-session"  // no jwt available; can't fetch

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [status, setStatus] = useState<ProjectLoadStatus>("loading")
  const hasLoaded = useRef(false)
  const { session } = useFrontierSession()

  const refresh = useCallback(() => {
    if (!hasLoaded.current) setStatus("loading")

    let cancelled = false
    ;(async () => {
      if (!session?.jwt) {
        if (cancelled) return
        setProject(null)
        setStatus("no-session")
        hasLoaded.current = true
        return
      }
      const state = await resolveCloudProject(projectId, session.jwt)
      if (cancelled) return
      if (!state) {
        setProject(null)
        setStatus("not-found")
        hasLoaded.current = true
        return
      }
      const hydrated = await overlayLocalProjectState(minimalProjectRecord(state))
      setProject(hydrated)
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
  // the hydrated record so existing consumers see merged values without any
  // per-callsite changes.
  const roleLevel = project?.syncRole?.level ?? null
  const { settings: syncedSettings } = useProjectSettings(projectId, roleLevel)
  const overlaid = project ? overlaySettings(project, syncedSettings) : null

  return {
    project: overlaid,
    status,
    loading: status === "loading",
    isError: status === "not-found",
    refresh,
  }
}
