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
  /** True when the last save returned a 409 conflict. The user's pending edits
   *  were snapped to the server winner; the UI should show a visible notice.
   *  SWARM-TODO: preserve pending form values across a conflict instead of
   *  discarding them (requires lifting draft state into the hook or passing
   *  pending values back via the conflict payload). */
  conflict: boolean
  /** Call to dismiss the conflict notice after the user has acknowledged it. */
  dismissConflict: () => void
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
  if (record.validationRoleFloor != null) out.validationRoleFloor = record.validationRoleFloor
  if (record.validationNamedUsers != null) out.validationNamedUsers = record.validationNamedUsers
  if (record.allowSelfValidation != null) out.allowSelfValidation = record.allowSelfValidation
  if (record.ttsSettings != null) {
    const { apiKey, ...ttsRest } = record.ttsSettings
    void apiKey
    out.ttsSettings = ttsRest
  }
  if (record.terminology != null) out.terminology = record.terminology
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
  const [conflict, setConflict] = useState(false)
  const dismissConflict = useCallback(() => setConflict(false), [])

  // aliveRef tracks component liveness for long-running callbacks that start
  // *outside* of an effect (e.g. the write-path patch() and refresh() called
  // imperatively by callers). It is NOT used to guard the initial-fetch effect
  // — that effect uses a per-invocation `let alive` local so StrictMode's
  // mount→cleanup→remount cycle cannot poison the surviving mount.
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  const mountAtRef = useRef(performance.now())

  // All server-side writes (the one-shot migration + every user `patch`) go
  // through this promise chain. Without it, the migration's PATCH and a fast
  // user blur both hit the server with `ifMatchVersion=0` against a fresh
  // settings row — one wins and the other 409s. Serializing means the second
  // write reads the just-bumped `server.version`, so its `ifMatchVersion`
  // matches and the user's edit lands without a console error.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const runSerialized = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = writeChainRef.current.then(fn, fn)
    writeChainRef.current = next.catch(() => {})
    return next
  }, [])

  // Live ref to the latest server snapshot so serialized writers see the
  // version bumped by the writer ahead of them in the queue. MUST stay in
  // lockstep with `setServer` calls — a useEffect mirror is too late, because
  // the next queued PATCH runs in the same microtask the previous one
  // resolves, well before React commits and runs the effect.
  const serverRef = useRef<ProjectSettingsResponse | null>(null)
  const writeServer = useCallback((next: ProjectSettingsResponse | null) => {
    serverRef.current = next
    setServer(next)
  }, [])

  // Keep a ref so refresh's identity is stable across connectivity changes.
  const isOnlineRef = useRef(isOnline)
  useEffect(() => {
    isOnlineRef.current = isOnline
  }, [isOnline])

  const refresh = useCallback(async (): Promise<ProjectSettingsResponse | null> => {
    if (!projectId || !jwt) return null
    if (!isOnlineRef.current) return null
    const got = await fetchProjectSettings(jwt, projectId)
    // Guard against post-unmount state updates. aliveRef is only set false on
    // final unmount; explicit refresh() calls from still-mounted consumers
    // should always land (aliveRef.current will be true for them).
    if (!aliveRef.current) return null
    writeServer(got)
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
          ...(got.settings.terminology != null
            ? { terminology: got.settings.terminology }
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
  //
  // IMPORTANT: we use a per-invocation `alive` local (not `aliveRef`) to guard
  // state updates. Under React StrictMode the effect runs twice:
  //   mount → cleanup (sets aliveRef.current=false) → remount
  // If we used `aliveRef` here, the surviving remount's async callbacks would
  // see aliveRef.current===false and silently drop the fetched settings, leaving
  // server===null and hasFetched===false forever (BUG-TERM-1).
  // The per-invocation local is flipped only in THIS closure's cleanup, so each
  // effect run has its own independent alive flag. aliveRef is reserved for
  // post-unmount guards on imperatively-called refresh()/patch().
  useEffect(() => {
    if (!projectId) return
    let alive = true
    // Reset aliveRef so that refresh() (which uses aliveRef for its own
    // post-unmount guard) works correctly on the surviving mount after StrictMode
    // runs the cleanup on the first mount.
    aliveRef.current = true

    void getProject(projectId)
      .then((rec) => {
        if (!alive) return
        setLocal(localSettingsFrom(rec))
        // Kick off server fetch after local state is set.
        void refresh()
      })
      .catch((err) => {
        if (!alive) return
        console.warn("[useProjectSettings] failed to read local IDB cache", err)
        // Continue with empty local; refresh still fires so server values appear.
        void refresh()
      })
    return () => {
      alive = false
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
      const baseVersion = serverRef.current?.version ?? 0
      const out = await runSerialized(() =>
        patchProjectSettings(jwt, projectId, local, baseVersion),
      )
      if (!aliveRef.current) return
      const nonEmptyCount = Object.keys(local).filter((k) => {
        const v = (local as any)[k]
        return v !== "" && v != null
      }).length
      if (out.kind === "ok") {
        writeServer(out.value)
        posthog.capture("project settings migrated", {
          project_id: projectId,
          fields_count: nonEmptyCount,
        })
      } else if (out.kind === "conflict") {
        writeServer(out.latest)
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

    // Serialize the network write so it can't race the one-shot migration or a
    // prior user patch. Reading server state from the ref *inside* the
    // serialized callback means we always see the version bumped by the
    // writer ahead of us in the queue.
    let result: PatchResult = await runSerialized(async () => {
      // Fetch the latest server snapshot right before the write. This is the
      // belt-and-suspenders fix for the persistent 409s: even with our write
      // queue and live `serverRef`, the cached version can drift from the
      // real DB row (initial fetch hadn't landed, a previous tab wrote, an
      // earlier session's migration succeeded but its response was dropped,
      // etc.). One extra GET per save eliminates the whole class of bug.
      const fresh = (await fetchProjectSettings(jwt, projectId)) ?? serverRef.current
      const baseVersion = fresh?.version ?? 0
      const optimistic: ProjectSettingsResponse = {
        version: baseVersion,
        updatedAt: fresh?.updatedAt ?? new Date().toISOString(),
        updatedBy: fresh?.updatedBy ?? null,
        settings: { ...(fresh?.settings ?? {}), ...partial },
      }
      writeServer(optimistic)

      // Retry once for the (now rare) case that a concurrent writer slipped
      // in between the GET above and our PATCH.
      const first = await patchProjectSettings(jwt, projectId, optimistic.settings, baseVersion)
      const outcome =
        first.kind === "conflict"
          ? await patchProjectSettings(
              jwt,
              projectId,
              { ...first.latest.settings, ...partial },
              first.latest.version,
            )
          : first
      // Commit the authoritative result to `serverRef` *before* the next
      // serialized writer runs. Without this, a back-to-back save would read
      // the optimistic version we wrote above and send the same `ifMatchVersion`
      // twice — guaranteed 409.
      if (outcome.kind === "ok") writeServer(outcome.value)
      else if (outcome.kind === "conflict") writeServer(outcome.latest)
      return outcome
    })
    if (!aliveRef.current) return { kind: "ok" }

    if (result.kind === "ok") {
      writeServer(result.value)
      return { kind: "ok" }
    }
    if (result.kind === "conflict") {
      writeServer(result.latest)
      // Snap local + IDB to the conflict winner so the overlay stops lying
      // about what state we're in. Without this, `local` keeps the user's
      // doomed edit and the overlay merges it on top of the server truth.
      setLocal((prev) => ({ ...prev, ...result.latest.settings }))
      void patchProject(projectId, (existing) => ({ ...existing, ...result.latest.settings })).catch((err) => {
        console.warn("[useProjectSettings] local IDB conflict-snap failed", err)
      })
      setConflict(true)
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
  }, [projectId, jwt, roleLevel, refresh, runSerialized])

  return {
    settings,
    version: server ? server.version : null,
    updatedBy: server?.updatedBy ?? null,
    updatedAt: server?.updatedAt ?? null,
    hasFetched,
    isOnline,
    canEdit,
    reasonCannotEdit,
    conflict,
    dismissConflict,
    refresh,
    patch,
  }
}
