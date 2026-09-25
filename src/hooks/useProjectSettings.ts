import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOnline } from "@/hooks/useOnline"
import { useT } from "@/lib/i18n/I18nProvider"
import { getProject, patchProject } from "@/lib/store/project-index"
import { ROLE } from "@/lib/frontier/roles"
import { resolveTermbaseEditFloor } from "@/lib/terminology/glossary-view"
import { resolveLanguageEditFloor } from "@/lib/sync/role-policy"
import {
  fetchProjectSettingsResult,
  patchProjectSettings,
  type PatchResult,
  type ProjectWideSettings,
  type ProjectSettingsResponse,
} from "@/lib/sync/project-settings"
import posthog from "@/lib/posthog"
import { subscribeWindowRegainedFocus } from "@/lib/sync/window-focus-revalidate"

// Floor aligned with the server's SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER (600).
// Spec (01-personas-and-roles.md §Role ladder): "Invite / remove members; change
// project settings (languages, system prompt, validation rules, health) — maintainer"
// (row 600). Lowering the floor to PROJECT_LEAD (500) would widen server permissions
// without spec support — do not change without a matching auth-worker update + spec citation.
export const SETTINGS_EDIT_ROLE_FLOOR = ROLE.MAINTAINER

/**
 * AQU-822: the one settings key that does NOT sit behind
 * {@link SETTINGS_EDIT_ROLE_FLOOR}. A patch that touches only `terminology`
 * is gated by the org's configurable `termbaseEditMinRole` floor instead
 * (default project_lead 500), so an org can let translators own terminology
 * without handing them AI config, languages, or health thresholds.
 *
 * Mirrors the server carve-out in auth-worker/src/routes/project-settings.ts,
 * which re-derives the same "only terminology changed" test against the
 * stored row and remains authoritative.
 */
const TERMINOLOGY_KEY = "terminology"

/** True when a patch changes the termbase and nothing else. */
export function isTerminologyOnlyPatch(partial: ProjectWideSettings): boolean {
  const keys = Object.keys(partial)
  return keys.length > 0 && keys.every((key) => key === TERMINOLOGY_KEY)
}

/** AQU-1083: the second key with a floor below maintainer. */
export const COUNT_STRUCTURAL_KEY = "countStructuralCells"

/**
 * Is this patch only the structural-cells override?
 *
 * Mirrors the terminology carve-out above, and mirrors the server's, which is
 * the point: this hook refuses a write it believes the server would reject, so
 * a floor it does not know about shows up as a control that silently does
 * nothing for exactly the role the feature was written for.
 */
export function isCountStructuralOnlyPatch(partial: ProjectWideSettings): boolean {
  const keys = Object.keys(partial)
  return keys.length > 0 && keys.every((key) => key === COUNT_STRUCTURAL_KEY)
}

/**
 * AQU-1086: the project-language keys, gated by the org's configurable
 * `languageEditMinRole` (default maintainer 600 — today's behaviour) rather
 * than {@link SETTINGS_EDIT_ROLE_FLOOR}. The default target language and the
 * extra-lane registry are one scope so the Project Info and Languages cards
 * can never disagree about who may edit them (AQU-898).
 *
 * Mirrors the server carve-out in auth-worker/src/routes/project-settings.ts,
 * which re-derives the same "only language keys changed" test against the
 * stored row and remains authoritative.
 */
const LANGUAGE_KEYS = new Set(["sourceLanguage", "targetLanguage", "targetLanes", "archivedLanes"])

/** True when a patch changes only project-language keys. */
export function isLanguageOnlyPatch(partial: ProjectWideSettings): boolean {
  const keys = Object.keys(partial)
  return keys.length > 0 && keys.every((key) => LANGUAGE_KEYS.has(key))
}

/**
 * AQU-1246: the second key that does NOT sit behind
 * {@link SETTINGS_EDIT_ROLE_FLOOR}. A patch that touches only
 * `autopilotEnabled` — opting this project into (or out of) the experimental
 * Autopilot surface — is admitted at project_lead(500)+.
 *
 * Deliberately a carve-out rather than a floor change: whether your own
 * project may try an experiment is a lead's call, and admitting this one key
 * hands a lead nothing else. Everything above it (languages, system prompt,
 * validation rules, health) keeps the maintainer gate.
 *
 * Mirrors the server carve-out in auth-worker/src/routes/project-settings.ts,
 * which re-derives the same "only this key changed" test against the stored
 * row and remains authoritative. This client copy exists to stop a
 * guaranteed-403 write and to keep the AQU-255 rule intact (never apply a
 * below-floor patch locally).
 */
export const AUTOPILOT_EDIT_ROLE_FLOOR = ROLE.PROJECT_LEAD

const AUTOPILOT_KEY = "autopilotEnabled"

/** True when a patch changes the Autopilot opt-in and nothing else. */
export function isAutopilotOnlyPatch(partial: ProjectWideSettings): boolean {
  const keys = Object.keys(partial)
  return keys.length > 0 && keys.every((key) => key === AUTOPILOT_KEY)
}

/**
 * Copy one settings key across. Generic over the key so both sides of the
 * assignment are the same `ProjectWideSettings[K]`; a write keyed by the whole
 * `keyof` union does not typecheck, which is why the call sites below used to
 * cast the value away.
 */
function copySettingsKey<K extends keyof ProjectWideSettings>(
  target: ProjectWideSettings,
  source: ProjectWideSettings,
  key: K,
): void {
  target[key] = source[key]
}

/**
 * Roll a settings snapshot back to server truth for exactly the keys a
 * rejected patch tried to write: a key the server stores takes its stored
 * value back, a key it does not know is dropped, and anything outside the
 * write attempt is left alone.
 */
function rollbackRejectedKeys(
  prev: ProjectWideSettings,
  partial: ProjectWideSettings,
  snapTarget: ProjectWideSettings,
): ProjectWideSettings {
  const next = { ...prev }
  for (const key of Object.keys(partial) as (keyof ProjectWideSettings)[]) {
    if (key in snapTarget) {
      copySettingsKey(next, snapTarget, key)
    } else {
      delete next[key]
    }
  }
  return next
}

/**
 * AQU-979: the same-tab convergence channel for project-wide settings.
 *
 * Project settings are PATCHed through auth-worker's REST API, not the sync
 * event log, so nothing in the SPA's own state graph tells a *sibling*
 * `useProjectSettings` instance that a write just landed. That matters because
 * `/project/:id/settings` renders as a route-modal **over the still-mounted
 * ProjectWorkspace** (see App.tsx `backgroundLocation` routes): the dialog owns
 * one hook instance, the workspace owns another, and only the dialog's instance
 * sees the patch. Before AQU-979 the workspace's instance converged only via the
 * server round-trip (auth-worker → best-effort sync-worker notify → DO
 * `project.settings.updated` frame → ProjectWorkspace relay) or on window focus
 * — neither of which fires when the user closes the dialog and keeps editing in
 * the same tab. The workspace therefore kept the OLD `sourceLanguage` /
 * `targetLanguage`, and since `useCompletion` takes both from that record, an AI
 * generation triggered right after a language change ran against the stale
 * language until a manual page reload.
 *
 * Broadcasting locally on every successful write closes that window without
 * waiting on (or trusting) the best-effort server notify. The DO relay keeps
 * dispatching the same event for *remote* writers, so cross-tab and
 * cross-collaborator convergence is unchanged.
 */
export const PROJECT_SETTINGS_UPDATED_EVENT = "aquilla:project-settings-updated"

export interface ProjectSettingsUpdatedDetail {
  projectId: string
  version?: number
  /**
   * Instance id of the hook that performed the write, when the event came from
   * a local patch. The originating instance already holds the authoritative
   * response, so it skips the redundant re-GET; every other instance refreshes.
   * Absent for the DO relay (a remote write — everyone must refresh).
   */
  origin?: string
}

/** Tell every other mounted settings consumer in this tab to re-read the row. */
export function broadcastProjectSettingsUpdated(detail: ProjectSettingsUpdatedDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ProjectSettingsUpdatedDetail>(PROJECT_SETTINGS_UPDATED_EVENT, { detail }),
  )
}

let settingsInstanceSeq = 0

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
  /**
   * AQU-1083: the org default this project inherits when it has no
   * `countStructuralCells` of its own. Null when the project has no org, or
   * before the first response that carries it — read it as
   * `settings.countStructuralCells ?? orgCountStructuralCells ?? true`.
   */
  orgCountStructuralCells: boolean | null
  isOnline: boolean
  canEdit: boolean
  reasonCannotEdit: CannotEditReason
  /** AQU-1086: whether the caller may edit the project-language keys
   *  (`sourceLanguage`, `targetLanguage`, `targetLanes`, `archivedLanes`).
   *  Same as {@link canEdit} unless the org lowered `languageEditMinRole`
   *  below MAINTAINER, in which case a project lead gets the language fields
   *  while the rest of the form stays locked. */
  canEditLanguages: boolean
  reasonCannotEditLanguages: CannotEditReason
  /** The effective language floor used by {@link canEditLanguages} — for the
   *  lock hint, which must name the role the user actually needs rather than
   *  a hardcoded "Maintainer" (AQU-427 convention). */
  languageEditFloor: number
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
   *  MAINTAINER (600) — except a terminology-only patch, gated by the org's
   *  `termbaseEditMinRole` floor (AQU-822), and an autopilotEnabled-only
   *  patch, gated by PROJECT_LEAD (AQU-1246). Server-forbidden writes are
   *  surfaced as blocked and the optimistic overlay is rolled back — no silent
   *  local divergence. */
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>
}

export interface UseProjectSettingsOptions {
  /**
   * AQU-822: the org's effective termbase-edit floor for this project
   * (`ProjectRecord.termbaseEditMinRole`, resolved server-side). Applies only
   * to terminology-only patches; every other key keeps the MAINTAINER floor.
   * Omitted ⇒ the PROJECT_LEAD default.
   */
  termbaseEditMinRole?: number | null
  /**
   * AQU-1086: the org's effective language-edit floor for this project
   * (`ProjectRecord.languageEditMinRole`, resolved server-side). Applies only
   * to language-only patches; every other key keeps the MAINTAINER floor.
   * Omitted ⇒ the MAINTAINER default (today's behaviour).
   */
  languageEditMinRole?: number | null
  /**
   * AQU-1274: role context stamped onto the `project settings hydrated`
   * PostHog event. A hidden panel is indistinguishable from a broken one in
   * telemetry unless the event says which role the viewer actually resolved
   * to and which grant path produced it — diagnosing the Biblica ETT report
   * took a screenshot hunt for exactly this reason. Optional: callers that
   * don't have the role context omit it and the properties are absent.
   */
  roleTelemetry?: {
    /** The viewer's `org_members` role level, or null if not an org member. */
    orgRole: number | null
    /** The resolved (max-wins) role level on this project. */
    resolvedRole: number | null
    /** Which grant path won: override | group | org | creator | platform. */
    resolvedFrom: string | null
  }
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

// useOnline moved to @/hooks/useOnline (2026-08-05) — shared with the
// recording modal's offline gate.

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
  // AQU-1083. `!= null` rather than a truthiness test: `false` is a real
  // answer here — it is the whole point of the setting — and absent means
  // "inherit the org", which must stay absent rather than become `false`.
  if (record.countStructuralCells != null)
    out.countStructuralCells = record.countStructuralCells
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
  options?: UseProjectSettingsOptions,
): UseProjectSettings {
  const termbaseEditMinRole = options?.termbaseEditMinRole
  const languageEditMinRole = options?.languageEditMinRole
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const isOnline = useOnline()
  const t = useT()

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

  // AQU-979: stable per-instance id so this hook can ignore the settings-updated
  // event it broadcast itself (it already holds the authoritative response).
  const instanceIdRef = useRef<string>("")
  if (!instanceIdRef.current) instanceIdRef.current = `ps-${++settingsInstanceSeq}`

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
  // AQU-1083: the org default, held apart from the snapshot above because not
  // every snapshot carries it — the optimistic one built during a patch has no
  // server response behind it, and a server that predates the field omits it.
  // Either would otherwise blank the org default for a moment and flip the
  // project control's meaning while a save was in flight.
  const [orgCountStructuralCells, setOrgCountStructuralCells] = useState<boolean | null>(null)
  const writeServer = useCallback((next: ProjectSettingsResponse | null) => {
    serverRef.current = next
    setServer(next)
    if (next?.orgCountStructuralCells !== undefined) {
      setOrgCountStructuralCells(next.orgCountStructuralCells)
    }
  }, [])

  // Keep a ref so refresh's identity is stable across connectivity changes.
  const isOnlineRef = useRef(isOnline)
  useEffect(() => {
    isOnlineRef.current = isOnline
  }, [isOnline])

  // AQU-1274: read through a ref so role context stamped on the hydration
  // event never becomes a refresh() dependency — the role resolves on its own
  // schedule and must not re-trigger the settings fetch (or re-fire the event).
  const roleTelemetryRef = useRef(options?.roleTelemetry)
  useEffect(() => {
    roleTelemetryRef.current = options?.roleTelemetry
  }, [options?.roleTelemetry])

  // React StrictMode invokes the initial hydration effect twice, and settings
  // can also be requested by more than one effect during a fast route change.
  // Keep one request per mounted consumer in flight and let every caller await
  // the same result instead of stacking identical GETs.
  const refreshInFlightRef = useRef<Promise<ProjectSettingsResponse | null> | null>(null)
  const refresh = useCallback(async (): Promise<ProjectSettingsResponse | null> => {
    if (!projectId || !jwt) return null
    if (!isOnlineRef.current) return null
    if (refreshInFlightRef.current) return refreshInFlightRef.current

    const request = (async (): Promise<ProjectSettingsResponse | null> => {
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
          // AQU-1274 — see UseProjectSettingsOptions.roleTelemetry.
          ...(roleTelemetryRef.current
            ? {
                org_role: roleTelemetryRef.current.orgRole,
                resolved_role: roleTelemetryRef.current.resolvedRole,
                resolved_from: roleTelemetryRef.current.resolvedFrom,
              }
            : {}),
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
            ...(got.settings.countStructuralCells != null
              ? { countStructuralCells: got.settings.countStructuralCells }
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
    })()
    refreshInFlightRef.current = request
    try {
      return await request
    } finally {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null
    }
  }, [projectId, jwt])

  // Hydrate local cache and server state in parallel on projectId change. The
  // server snapshot overlays local values, so their completion order is safe;
  // serializing these reads only made route-modals wait on IDB before the
  // authoritative request could even start.
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

    void refresh()
    void getProject(projectId)
      .then((rec) => {
        if (!alive) return
        const nextLocal = localSettingsFrom(rec)
        setLocal((prev) => projectWideSettingsEqual(prev, nextLocal) ? prev : nextLocal)
      })
      .catch((err) => {
        if (!alive) return
        console.warn("[useProjectSettings] failed to read local IDB cache", err)
        // Continue with empty local; the parallel refresh still supplies server values.
      })
    return () => {
      alive = false
    }
  }, [projectId, refresh])

  // Re-fetch only when transitioning offline -> online. Calling refresh on an
  // initially-online mount duplicates the parallel initial request above.
  const previousOnlineRef = useRef(isOnline)
  useEffect(() => {
    const wasOnline = previousOnlineRef.current
    previousOnlineRef.current = isOnline
    if (!wasOnline && isOnline && projectId && jwt) void refresh()
  }, [isOnline, projectId, jwt, refresh])

  // Project settings are written by identity, while the editor's live channel
  // is the project Durable Object. Two producers feed this listener:
  //   - ProjectWorkspace relays the additive DO frame (a REMOTE writer), and
  //   - AQU-979: `patch` below broadcasts locally the moment a write lands, so
  //     sibling instances in this tab (the settings route-modal vs. the
  //     workspace underneath it) converge without waiting on the best-effort
  //     server notify — or on a manual page reload.
  // Either way every mounted settings consumer converges without polling.
  useEffect(() => {
    if (!projectId || typeof window === "undefined") return
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSettingsUpdatedDetail>).detail
      if (detail?.projectId !== projectId) return
      // Our own write — `patch` already committed the authoritative response to
      // `serverRef`/`server`, so a re-GET would only cost a round-trip.
      if (detail.origin && detail.origin === instanceIdRef.current) return
      void refresh()
    }
    window.addEventListener(PROJECT_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => window.removeEventListener(PROJECT_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
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
    return subscribeWindowRegainedFocus(() => { void refresh() })
  }, [projectId, jwt, refresh])

  // Server values overlay local for keys the server has set (non-empty row).
  const settings: ProjectWideSettings = useMemo(
    () => server && server.version > 0
      ? mergeProjectWideSettings(local, server.settings)
      : local,
    [local, server],
  )

  const canEdit = isOnline && roleLevel != null && roleLevel >= SETTINGS_EDIT_ROLE_FLOOR
  const reasonCannotEdit: CannotEditReason = canEdit
    ? null
    : !isOnline
      ? "offline"
      : "role"

  // AQU-1086: the language keys carry their own (org-configurable) floor, so
  // the Project Info language fields and the Languages card gate on this
  // rather than on the hook-wide `canEdit`. Unsynced projects (roleLevel ==
  // null) keep the existing unrestricted local-edit path — see patch().
  const languageEditFloor = resolveLanguageEditFloor(languageEditMinRole)
  const canEditLanguages =
    isOnline && roleLevel != null && roleLevel >= languageEditFloor
  const reasonCannotEditLanguages: CannotEditReason = canEditLanguages
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
      const nonEmptyCount = Object.values(local).filter((v) => v !== "" && v != null).length
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
    // 4. roleLevel < the floor required for THIS patch → synced project, below
    //    floor. DO NOT apply locally — this was the root cause of AQU-255
    //    silent divergence. The server would reject, leaving stale IDB data
    //    the user can't clear.
    // 5. roleLevel >= that floor → optimistic local apply happens *after*
    //    this block, just before the serialized server write.
    //
    // AQU-822 / AQU-1086 / AQU-1246: the required floor is
    // SETTINGS_EDIT_ROLE_FLOOR (maintainer) for every patch EXCEPT three
    // single-scope carve-outs — a terminology-only one (org's configured
    // termbaseEditMinRole), a language-only one (org's configured
    // languageEditMinRole), and an autopilotEnabled-only one (project_lead).
    // Deriving it per-patch (rather than loosening the hook-wide floor) keeps
    // the AQU-255 guarantee intact for all the other keys.

    if (!projectId || !jwt) return { kind: "error", message: t("workspace.projectSettingsHook.noSessionError") }

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

    const requiredLevel =
      isTerminologyOnlyPatch(partial) ? resolveTermbaseEditFloor(termbaseEditMinRole)
      : isCountStructuralOnlyPatch(partial) ? ROLE.PROJECT_LEAD
      : isLanguageOnlyPatch(partial) ? languageEditFloor
      : isAutopilotOnlyPatch(partial) ? AUTOPILOT_EDIT_ROLE_FLOOR
      : SETTINGS_EDIT_ROLE_FLOOR
    if (roleLevel < requiredLevel) {
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
      // AQU-979: the row on the server has moved; tell every other mounted
      // consumer in this tab immediately. Without this the workspace under the
      // settings modal keeps the pre-save sourceLanguage/targetLanguage (and
      // useCompletion with it) until the DO notify lands or the page reloads.
      broadcastProjectSettingsUpdated({
        projectId,
        version: result.value.version,
        origin: instanceIdRef.current,
      })
      return { kind: "ok" }
    }
    if (result.kind === "conflict") {
      writeServer(result.latest)
      // A conflict still means the server row advanced (someone else's write
      // won). Siblings are just as stale as they'd be after our own write.
      broadcastProjectSettingsUpdated({
        projectId,
        version: result.latest.version,
        origin: instanceIdRef.current,
      })
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
      const snapTarget: ProjectWideSettings = serverRef.current?.settings ?? {}
      // Remove keys from partial that the server rejected; keep anything
      // that wasn't part of this write attempt.
      setLocal((prev) => rollbackRejectedKeys(prev, partial, snapTarget))
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
      // Read inside the updater, not at the call site: `refresh()` above is in
      // flight, so the snapshot this resolves to is whatever the ref holds when
      // React runs the update.
      const snapTarget: ProjectWideSettings = serverRef.current?.settings ?? {}
      return rollbackRejectedKeys(prev, partial, snapTarget)
    })
    return { kind: "error", message: result.message }
  }, [projectId, jwt, roleLevel, termbaseEditMinRole, languageEditFloor, refresh, runSerialized, t])

  return {
    settings,
    version: server ? server.version : null,
    updatedBy: server?.updatedBy ?? null,
    updatedAt: server?.updatedAt ?? null,
    hasFetched,
    orgCountStructuralCells,
    isOnline,
    canEdit,
    reasonCannotEdit,
    canEditLanguages,
    reasonCannotEditLanguages,
    languageEditFloor,
    conflict,
    dismissConflict,
    refresh,
    patch,
  }
}
