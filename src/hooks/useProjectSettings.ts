import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getProject, patchProject } from "@/lib/store/project-index"
import {
  fetchProjectSettings,
  type ProjectWideSettings,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"

const EDIT_ROLE_FLOOR = 500 // PROJECT_LEAD+

export type CannotEditReason = "offline" | "role" | null

export interface UseProjectSettings {
  /** Merged view: server values overlay local IDB values for keys the
   *  server has set. Always defined (may be empty). */
  settings: ProjectWideSettings
  /** Server version of the settings row. null = never fetched yet. */
  version: number | null
  /** "When was this last edited and by whom" — null if no server row yet. */
  updatedBy: { id: number; username: string } | null
  updatedAt: string | null
  /** True after the first GET resolves (success OR network failure). */
  hasFetched: boolean
  isOnline: boolean
  canEdit: boolean
  reasonCannotEdit: CannotEditReason
  /** Force a re-GET. */
  refresh: () => Promise<ProjectSettingsResponse | null>
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}

function localSettingsFrom(
  record: Awaited<ReturnType<typeof getProject>>,
): ProjectWideSettings {
  if (!record) return {}
  const out: ProjectWideSettings = {}
  if (record.sourceLanguage != null) out.sourceLanguage = record.sourceLanguage
  if (record.targetLanguage != null) out.targetLanguage = record.targetLanguage
  if (record.completionSettings?.systemPrompt != null)
    out.systemPrompt = record.completionSettings.systemPrompt
  if (record.rules != null) out.rules = record.rules
  if (record.rulePenalties != null) out.rulePenalties = record.rulePenalties
  if (record.healthSettings != null) out.healthSettings = record.healthSettings
  if (record.validationCount != null) out.validationCount = record.validationCount
  if (record.validationCountAudio != null)
    out.validationCountAudio = record.validationCountAudio
  return out
}

export function useProjectSettings(
  projectId: string | null,
  roleLevel: number | null,
): UseProjectSettings {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const isOnline = useOnline()

  const [server, setServer] = useState<ProjectSettingsResponse | null>(null)
  const [local, setLocal] = useState<ProjectWideSettings>({})
  const [hasFetched, setHasFetched] = useState(false)

  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  // Keep a ref so refresh's identity is stable across connectivity changes.
  const isOnlineRef = useRef(isOnline)
  useEffect(() => {
    isOnlineRef.current = isOnline
  }, [isOnline])

  const refresh = useCallback(async (): Promise<ProjectSettingsResponse | null> => {
    if (!projectId || !jwt) return null
    if (!isOnlineRef.current) return null
    const got = await fetchProjectSettings(jwt, projectId)
    if (!aliveRef.current) return null
    setServer(got)
    setHasFetched(true)
    if (got && got.version > 0) {
      try {
        await patchProject(projectId, (existing) => ({
          ...existing,
          ...(got.settings.sourceLanguage != null
            ? { sourceLanguage: got.settings.sourceLanguage }
            : {}),
          ...(got.settings.targetLanguage != null
            ? { targetLanguage: got.settings.targetLanguage }
            : {}),
          ...(got.settings.systemPrompt != null
            ? {
                completionSettings: {
                  ...(existing.completionSettings ?? ({} as any)),
                  systemPrompt: got.settings.systemPrompt,
                },
              }
            : {}),
          ...(got.settings.rules != null ? { rules: got.settings.rules } : {}),
          ...(got.settings.rulePenalties != null
            ? { rulePenalties: got.settings.rulePenalties }
            : {}),
          ...(got.settings.healthSettings != null
            ? { healthSettings: got.settings.healthSettings }
            : {}),
          ...(got.settings.validationCount != null
            ? { validationCount: got.settings.validationCount }
            : {}),
          ...(got.settings.validationCountAudio != null
            ? { validationCountAudio: got.settings.validationCountAudio }
            : {}),
        }))
      } catch (err) {
        console.warn("[useProjectSettings] failed to mirror settings to IDB", err)
      }
    }
    return got
  }, [projectId, jwt])

  // Hydrate local cache on projectId change, then kick off the server fetch.
  // Sequencing local-before-remote is intentional: local state is shown
  // immediately while the network round-trip is in flight.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void getProject(projectId)
      .then((rec) => {
        if (cancelled || !aliveRef.current) return
        setLocal(localSettingsFrom(rec))
        // Kick off server fetch after local state is set.
        void refresh()
      })
      .catch((err) => {
        if (cancelled || !aliveRef.current) return
        console.warn("[useProjectSettings] failed to read local IDB cache", err)
        // Continue with empty local; refresh still fires so server values appear.
        void refresh()
      })
    return () => {
      cancelled = true
    }
  }, [projectId, refresh])

  // Re-fetch when transitioning offline -> online.
  useEffect(() => {
    if (isOnline && projectId && jwt) void refresh()
  }, [isOnline, projectId, jwt, refresh])

  // Server values overlay local for keys the server has set (non-empty row).
  const settings: ProjectWideSettings =
    server && server.version > 0 ? { ...local, ...server.settings } : local

  const canEdit = isOnline && roleLevel != null && roleLevel >= EDIT_ROLE_FLOOR
  const reasonCannotEdit: CannotEditReason = canEdit
    ? null
    : !isOnline
      ? "offline"
      : "role"

  return {
    settings,
    version: server ? server.version : null,
    updatedBy: server?.updatedBy ?? null,
    updatedAt: server?.updatedAt ?? null,
    hasFetched,
    isOnline,
    canEdit,
    reasonCannotEdit,
    refresh,
  }
}
