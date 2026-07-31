import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getProject, patchProject } from "@/lib/store/project-index"
import { ROLE } from "@/lib/frontier/roles"
import {
  fetchProjectSettingsResult,
  patchProjectSettings,
  type PatchResult,
  type ProjectWideSettings,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"
import posthog from "@/lib/posthog"

// Floor aligned with the server's SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER (600).
// Spec (01-personas-and-roles.md §Role ladder): "Invite / remove members; change
// project settings (languages, system prompt, validation rules, health) — maintainer"
// (row 600). Lowering the floor to PROJECT_LEAD (500) would widen server permissions
// without spec support — do not change without a matching auth-worker update + spec citation.
const EDIT_ROLE_FLOOR = ROLE.MAINTAINER

export type CannotEditReason = "offline" | "role" | null

export type PatchOutcome =
  | { kind: "ok" }
  | { kind: "conflict"; latest: ProjectSettingsResponse }
  | { kind: "blocked"; reason: "offline" | "role" }
  | { kind: "error"; message: string }

/**
 * Map a non-`ok` {@link PatchOutcome} to a user-facing message, or `null` when
 * the write succeeded. `patch` never rejects — it resolves an outcome — so any
 * caller that ignores the result silently swallows role/offline/conflict/server
 * failures (the AQU-749 class of silent no-op). Callers that write on a user's
 * behalf should surface `describePatchFailure(outcome)` instead of dropping it.
 */
export function describePatchFailure(outcome: PatchOutcome): string | null {
  switch (outcome.kind) {
    case "ok":
      return null
    case "blocked":
      return outcome.reason === "offline"
        ? "You're offline — reconnect to save term base changes."
        : "You need the Maintainer role or higher to change the term base."
    case "conflict":
      return "The term base was changed elsewhere. Re-open the concept and try again."
    case "error":
      return `Saving the term base failed: ${outcome.message}`
  }
}

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
   *  MAINTAINER (600). Server-forbidden writes are surfaced as blocked and
   *  the optimistic overlay is rolled back — no silent local divergence. */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a !== "object" || typeof b !== "object") return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function projectWideSettingsEqual(a: ProjectWideSettings, b: ProjectWideSettings): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ProjectWideSettings)[])
  for (const key of keys) {
    if (!settingsValueEqual(a[key], b[key])) return false
  }
  return true
}

function mergeProjectWideSettings(local: ProjectWideSettings, server: ProjectWideSettings): ProjectWideSettings {
  if (Object.keys(server).length === 0) return local
  let changed = false
  for (const key of Object.keys(server) as (keyof ProjectWideSettings)[]) {
    if (!settingsValueEqual(local[key], server[key])) {
      changed = true
      break
    }
  }
  return changed ? { ...local, ...server } : local
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
  if (record.algorithmicChecks != null) out.algorithmicChecks = record.algorithmicChecks
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
  if (record.livingMemoryEntries != null) out.livingMemoryEntries = record.livingMemoryEntries
  if (record.translationBrief != null) out.translationBrief = record.translationBrief
  if (record.draftContext != null) out.draftContext = record.draftContext
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
    const out = await fetchProjectSettingsResult(jwt, projectId)
    // Guard against post-unmount state updates. aliveRef is only set false on
    // final unmount; explicit refresh() calls from still-mounted consumers
    // should always land (aliveRef.current will be true for them).
    if (!aliveRef.current) return null
    if (!out.ok) {
      // FAIL CLOSED: the GET failed (network / 401 / 5xx) — the settings state
      // is UNKNOWN, not "empty". Do NOT mark hasFetched (consumers like the DCS
      // source lockdown treat un-fetched as locked), and do NOT clobber a
      // previously fetched server snapshot with null. The existing focus /
      // online / settings-updated revalidation paths retry the GET.
      return null
    }
    const got = out.value
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
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spread of partial settings object; exact shape depends on runtime migration state
                  ...(existing.completionSettings ?? ({} as any)),
                  systemPrompt: got.settings.systemPrompt,
                },
              }
            : {}),
          ...(got.settings.rules != null ? { rules: got.settings.rules } : {}),
          ...(got.settings.rulePenalties != null
            ? { rulePenalties: got.settings.rulePenalties }
            : {}),
          ...(got.settings.algorithmicChecks != null
            ? { algorithmicChecks: got.settings.algorithmicChecks }
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
          ...(got.settings.livingMemoryEntries != null
            ? { livingMemoryEntries: got.settings.livingMemoryEntries }
            : {}),
          ...(got.settings.translationBrief != null
            ? { translationBrief: got.settings.translationBrief }
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
        const nextLocal = localSettingsFrom(rec)
        setLocal((prev) => projectWideSettingsEqual(prev, nextLocal) ? prev : nextLocal)
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

  // Project settings are written by identity, while the editor's live channel
  // is the project Durable Object. ProjectWorkspace relays the additive DO
  // frame here so every mounted settings consumer converges without polling.
  useEffect(() => {
    if (!projectId || typeof window === "undefined") return
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: unknown }>).detail
      if (detail?.projectId !== projectId) return
      void refresh()
    }
    window.addEventListener("aquilla:project-settings-updated", onSettingsUpdated)
    return () => window.removeEventListener("aquilla:project-settings-updated", onSettingsUpdated)
  }, [projectId, refresh])

  // Re-fetch on tab focus / visibility regain (AQU-349). Validation-policy
  // settings (validationCount, validationRoleFloor, …) are PATCHed through the
  // auth-worker REST API, NOT the sync event log — so no WS `event.applied`
  // frame ever notifies a connected client that another maintainer changed
  // them. Without this, an already-open workspace keeps a STALE threshold until
  // a full page reload: a cell with 1 validation still renders "1/3 confirmed"
  // after the owner lowered the requirement to 1. `refresh()` re-GETs the
  // server row; the fresh validationCount overlays onto the ProjectRecord
  // (useProject) and useCells' threshold effect re-derives the badge. Mirrors
  // useCells' "refetch on focus is the cheap drift mitigation" for settings.
  useEffect(() => {
    if (!projectId || !jwt) return
    const revalidateOnVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      void refresh()
    }
    window.addEventListener("focus", revalidateOnVisible)
    document.addEventListener("visibilitychange", revalidateOnVisible)
    return () => {
      window.removeEventListener("focus", revalidateOnVisible)
      document.removeEventListener("visibilitychange", revalidateOnVisible)
    }
  }, [projectId, jwt, refresh])

  // Server values overlay local for keys the server has set (non-empty row).
  const settings: ProjectWideSettings = useMemo(
    () => server && server.version > 0
      ? mergeProjectWideSettings(local, server.settings)
      : local,
    [local, server],
  )

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key indexing into settings object; TS can't narrow string-keyed access
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
    // Gate logic for local apply vs. server write:
    //
    // 1. No jwt or no projectId → error immediately (no session/project).
    // 2. Offline → apply locally (preserve work, server reconciles on reconnect).
    // 3. roleLevel === null → unsynced project (server has no record of this
    //    project); apply locally only, no server roundtrip. Same as original.
    // 4. roleLevel < EDIT_ROLE_FLOOR → synced project, below floor. DO NOT apply
    //    locally — this was the root cause of AQU-255 silent divergence. The
    //    server would reject, leaving stale IDB data the user can't clear.
    // 5. roleLevel >= EDIT_ROLE_FLOOR → optimistic local apply happens *after*
    //    this block, just before the serialized server write.

    if (!projectId || !jwt) return { kind: "error", message: "no session or project" }

    if (!isOnlineRef.current) {
      // Offline — apply locally so work isn't lost; server will reconcile on reconnect.
      setLocal((prev) => ({ ...prev, ...partial }))
      void patchProject(projectId, (existing) => ({ ...existing, ...partial })).catch((err) => {
        console.warn("[useProjectSettings] local IDB patch failed (offline)", err)
      })
      return { kind: "blocked", reason: "offline" }
    }

    if (roleLevel == null) {
      // Unsynced project — only local storage exists; no server to write to.
      setLocal((prev) => ({ ...prev, ...partial }))
      void patchProject(projectId, (existing) => ({ ...existing, ...partial })).catch((err) => {
        console.warn("[useProjectSettings] local IDB patch failed (unsynced)", err)
      })
      return { kind: "blocked", reason: "role" }
    }

    if (roleLevel < EDIT_ROLE_FLOOR) {
      // Synced project below floor — do NOT apply locally; the server will
      // reject and we'd silently diverge (the original AQU-255 bug).
      return { kind: "blocked", reason: "role" }
    }

    // Optimistic local apply for synced+online+authorized path. We apply here
    // (after the role guard) rather than before it so a below-floor user never
    // writes stale data to IDB on a synced project.
    setLocal((prev) => ({ ...prev, ...partial }))
    void patchProject(projectId, (existing) => ({ ...existing, ...partial })).catch((err) => {
      console.warn("[useProjectSettings] local IDB patch failed", err)
    })

    // Serialize the network write so it can't race the one-shot migration or a
    // prior user patch. Reading server state from the ref *inside* the
    // serialized callback means we always see the version bumped by the
    // writer ahead of us in the queue.
    const result: PatchResult = await runSerialized(async () => {
      // Fetch the latest server snapshot right before the write. This is the
      // belt-and-suspenders fix for the persistent 409s: even with our write
      // queue and live `serverRef`, the cached version can drift from the
      // real DB row (initial fetch hadn't landed, a previous tab wrote, an
      // earlier session's migration succeeded but its response was dropped,
      // etc.). One extra GET per save eliminates the whole class of bug.
      const probe = await fetchProjectSettingsResult(jwt, projectId)
      const fresh = (probe.ok ? probe.value : null) ?? serverRef.current
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
      // Server rejected the write (role check failed at the API layer). Roll back
      // the optimistic local state we applied above — do not silently retain the
      // rejected value per AQU-255 acceptance criteria.
      void refresh() // revert optimistic overlay by re-fetching truth
      const snapTarget = serverRef.current?.settings ?? {}
      setLocal((prev) => {
        // Remove keys from partial that the server rejected; keep anything
        // that wasn't part of this write attempt.
        const next = { ...prev }
        for (const key of Object.keys(partial) as (keyof ProjectWideSettings)[]) {
          if (key in snapTarget) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key assignment; TS can't narrow the value type for string-keyed writes on a record type
            next[key] = snapTarget[key] as any
          } else {
            delete next[key]
          }
        }
        return next
      })
      void patchProject(projectId, (existing) => {
        // Roll back IDB keys to server truth for the keys in partial.
        const next = { ...existing }
        for (const key of Object.keys(partial)) {
          if (key in snapTarget) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key assignment during IDB rollback; string-keyed writes require any cast
            ;(next as any)[key] = (snapTarget as any)[key]
          }
        }
        return next
      }).catch((err) => {
        console.warn("[useProjectSettings] local IDB forbidden-rollback failed", err)
      })
      posthog.capture("project settings write forbidden", {
        project_id: projectId,
        role_level: roleLevel,
      })
      return { kind: "blocked", reason: "role" }
    }
    // Network/server error — roll back optimistic local apply so IDB doesn't
    // permanently diverge from server truth.
    void refresh()
    setLocal((prev) => {
      const snapTarget = serverRef.current?.settings ?? {}
      const next = { ...prev }
      for (const key of Object.keys(partial) as (keyof ProjectWideSettings)[]) {
        if (key in snapTarget) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key assignment during optimistic rollback; TS can't narrow string-keyed writes
          next[key] = snapTarget[key] as any
        } else {
          delete next[key]
        }
      }
      return next
    })
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
