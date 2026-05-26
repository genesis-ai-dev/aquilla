import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getProject, patchProject } from "@/lib/store/project-index"
import { ROLE } from "@/lib/frontier/roles"
import {
  fetchProjectSettings,
  patchProjectSettings,
  type PatchResult,
  type ProjectWideSettings,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"
import posthog from "@/lib/posthog"

const EDIT_ROLE_FLOOR = ROLE.PROJECT_LEAD

export type CannotEditReason = "offline" | "role" | null

export type PatchOutcome =
  | { kind: "ok" }
  | { kind: "conflict"; latest: ProjectSettingsResponse }
  | { kind: "blocked"; reason: "offline" | "role" }
  | { kind: "error"; message: string }

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
  /** Apply a partial settings update. Optimistic local update, server PATCH,
   *  conflict-snap on 409, returns outcome. Blocked when offline or below
   *  PROJECT_LEAD. */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
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

  const mountAtRef = useRef(performance.now())

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
    if (got) {
      posthog.capture("project settings hydrated", {
        project_id: projectId,
        within_ms: Math.round(performance.now() - mountAtRef.current),
        has_server_row: got.version > 0,
      })
    }
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

  // One-shot migration: push local IDB values to the server when the server
  // row is empty (version 0) and the caller has PROJECT_LEAD+ authority.
  // This handles projects created locally before cloud settings existed.
  const migrationFiredRef = useRef(false)
  useEffect(() => {
    if (migrationFiredRef.current) return
    if (!hasFetched) return
    if (!server || server.version !== 0) return
    if (!canEdit) return
    if (!projectId || !jwt) return
    // Treat local as empty if every value is an empty string / falsy primitive.
    if (!Object.values(local).some((v) => v !== "" && v != null)) return

    // Claim the flag before the await so a re-render during the network call
    // cannot double-fire within this hook instance.
    migrationFiredRef.current = true
    void (async () => {
      const out = await patchProjectSettings(jwt, projectId, local, 0)
      if (!aliveRef.current) return
      const nonEmptyCount = Object.keys(local).filter((k) => {
        const v = (local as any)[k]
        return v !== "" && v != null
      }).length
      if (out.kind === "ok") {
        setServer(out.value)
        posthog.capture("project settings migrated", {
          project_id: projectId,
          fields_count: nonEmptyCount,
        })
      } else if (out.kind === "conflict") {
        setServer(out.latest)
        posthog.capture("project settings migration conflict", {
          project_id: projectId,
          fields_count: nonEmptyCount,
        })
      }
      // forbidden / error: leave server at version 0; display is still backed
      // by local cache. A fresh hook instance will retry on next mount.
    })()
  }, [hasFetched, server, canEdit, local, jwt, projectId])

  const patch = useCallback(async (partial: ProjectWideSettings): Promise<PatchOutcome> => {
    // Apply locally *before* the gates. The original implementation gated the
    // entire write — including the local IDB / local-state mirror — behind
    // jwt+online+role, which silently dropped every edit on unsynced or
    // offline projects. For the synced-no-perm case the local apply is
    // reverted by the next server fetch anyway (callers gate the UI with
    // `disabled={!canEditShared && synced}` so users don't see a phantom
    // edit); for unsynced projects this is the only place the value ever
    // lands. setLocal is synchronous so the next render reflects it; the
    // patchProject write to IDB is fire-and-forget.
    setLocal((prev) => ({ ...prev, ...partial }))
    if (projectId) {
      void patchProject(projectId, (existing) => ({ ...existing, ...partial })).catch((err) => {
        console.warn("[useProjectSettings] local IDB patch failed", err)
      })
    }

    if (!projectId || !jwt) return { kind: "error", message: "no session or project" }
    if (!isOnlineRef.current) return { kind: "blocked", reason: "offline" }
    if (roleLevel == null || roleLevel < EDIT_ROLE_FLOOR) return { kind: "blocked", reason: "role" }

    // Optimistic server-side state so the UI feels instant for synced projects.
    const baseVersion = server?.version ?? 0
    const optimistic: ProjectSettingsResponse = {
      version: baseVersion,
      updatedAt: server?.updatedAt ?? new Date().toISOString(),
      updatedBy: server?.updatedBy ?? null,
      settings: { ...(server?.settings ?? {}), ...partial },
    }
    setServer(optimistic)

    const result: PatchResult = await patchProjectSettings(jwt, projectId, optimistic.settings, baseVersion)
    if (!aliveRef.current) return { kind: "ok" }

    if (result.kind === "ok") {
      setServer(result.value)
      return { kind: "ok" }
    }
    if (result.kind === "conflict") {
      setServer(result.latest)
      // Snap local + IDB to the conflict winner so the overlay stops lying
      // about what state we're in. Without this, `local` keeps the user's
      // doomed edit and the overlay merges it on top of the server truth.
      setLocal((prev) => ({ ...prev, ...result.latest.settings }))
      void patchProject(projectId, (existing) => ({ ...existing, ...result.latest.settings })).catch((err) => {
        console.warn("[useProjectSettings] local IDB conflict-snap failed", err)
      })
      posthog.capture("project settings sync conflict", {
        project_id: projectId,
        conflicting_user: result.latest.updatedBy?.username ?? null,
      })
      return { kind: "conflict", latest: result.latest }
    }
    if (result.kind === "forbidden") {
      void refresh() // revert optimistic by re-fetching truth
      return { kind: "blocked", reason: "role" }
    }
    void refresh()
    return { kind: "error", message: result.message }
  }, [projectId, jwt, roleLevel, server, refresh])

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
    patch,
  }
}
