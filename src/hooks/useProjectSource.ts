// Phase 5 / AD-9. Read + mutate a project's source-project link.
//
// "Project source" here is the AD-9 concept: `projects.source_project_id`
// — a self-FK pointing at an upstream source project. This is **not**
// `sourceLanguage` (a BCP-47 tag); they're orthogonal.
//
// The auth-worker doesn't yet ship a single endpoint returning the
// linked-source pair in one shot. Phase 1C added the link / detach
// mutations, but for *reading* the current link we lean on:
//   1. the source project id stored on the local IDB project record (if
//      the user has hydrated it), and
//   2. the fetch wrappers' POST responses on successful link/detach.
//
// A future server enhancement that exposes `source_project_id` on
// `GET /api/v2/projects/:id` will let `useProject` populate this hook
// for free; until then, callers may pass `initialSourceProjectId`
// derived from elsewhere (e.g. a project list join the dashboard does).

import { useCallback, useEffect, useRef, useState } from "react"
import {
  linkProjectToSource,
  detachProjectFromSource,
  SourceLinkingError,
} from "@/lib/sync/source-linking-read"
import type { DetachResult } from "@/lib/sync/source-linking-read-types"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"

export interface UseProjectSourceOptions {
  projectId: string | null
  /** Current `source_project_id` from whichever surface fetched it
   *  (auth-worker's projects endpoint, the IDB record, a list join).
   *  Null means "not linked" or "unknown — show as unlinked until a
   *  fresh link/detach roundtrip updates state." */
  initialSourceProjectId?: string | null
  /** Optional display name of the source project — surfaces in the
   *  badge. Resolvers like `useAccessibleProjects` can populate it. */
  initialSourceProjectName?: string
  /** Role level for permission gating. Below project_lead (500) the
   *  `link` / `detach` actions return without calling the server. */
  roleLevel?: number | null
}

export interface UseProjectSourceResult {
  /** Current upstream id, or null when not linked. Updated immediately on
   *  successful link / detach calls. */
  sourceProjectId: string | null
  /** Echo of the initial name (best-effort; not refetched on mutation). */
  sourceProjectName?: string
  /** True iff `sourceProjectId` is non-null. */
  isLinked: boolean
  /** True when the project has no target language configured — AD-9's
   *  "source-only" shape. Inferred from useProjectSettings. */
  isSourceOnly: boolean
  /** Project_lead+ permission gate. False ⇒ link/detach are no-ops. */
  canEditLink: boolean
  /** Last mutation error, surfaced as the user-facing reason string. */
  error: string | null
  /** In-flight mutation indicator. */
  isMutating: boolean
  /** POST /:projectId/link-source. Throws nothing; surfaces failures via
   *  `error`. Resolves to true iff the link landed. */
  link: (sourceProjectId: string) => Promise<boolean>
  /** POST /:projectId/detach-source. Resolves with the snapshot-burst
   *  result on success, or null on failure (with `error` populated). */
  detach: () => Promise<DetachResult | null>
}

/**
 * Map common HTTP failure cases to user-friendly strings. The server's
 * error body is JSON-encoded ({ error: "..." }); fall back to the raw
 * body otherwise so curious users still see something.
 */
function explainError(err: unknown): string {
  if (err instanceof SourceLinkingError) {
    let detail: string | null = null
    try {
      const parsed = JSON.parse(err.body) as { error?: string }
      if (typeof parsed.error === "string") detail = parsed.error
    } catch {
      detail = err.body
    }
    if (err.status === 403) {
      return "You need project-lead access to change the source link."
    }
    if (err.status === 404) {
      return "Source project unavailable (not found or no access)."
    }
    if (err.status === 409) {
      // Most common: cycle or "not linked." The body distinguishes.
      if (detail?.includes("cycle")) {
        return "Can't link to a downstream of this project — that would create a cycle."
      }
      return detail || "The link can't be applied to this project."
    }
    if (err.status === 400) {
      return detail || "Invalid request."
    }
    return detail || `Source link failed (HTTP ${err.status}).`
  }
  return err instanceof Error ? err.message : "Unknown error."
}

const PROJECT_LEAD = 500

export function useProjectSource(
  opts: UseProjectSourceOptions,
): UseProjectSourceResult {
  const { projectId, initialSourceProjectId, initialSourceProjectName, roleLevel } = opts
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const settings = useProjectSettings(projectId, roleLevel ?? null)

  const [sourceProjectId, setSourceProjectId] = useState<string | null>(
    initialSourceProjectId ?? null,
  )
  const [sourceProjectName, setSourceProjectName] = useState<string | undefined>(
    initialSourceProjectName,
  )
  const [error, setError] = useState<string | null>(null)
  const [isMutating, setIsMutating] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  // Reseed when the caller-supplied initial id changes — e.g. the
  // dashboard's project list refresh hands us a freshly-fetched value.
  useEffect(() => {
    setSourceProjectId(initialSourceProjectId ?? null)
    setSourceProjectName(initialSourceProjectName)
  }, [initialSourceProjectId, initialSourceProjectName])

  const canEditLink =
    typeof roleLevel === "number" && roleLevel >= PROJECT_LEAD && Boolean(jwt)

  // AD-9 source-only inference: a project is source-only when its
  // settings have no `targetLanguage`. We must wait until settings have
  // actually loaded (`hasFetched`) before claiming source-only — before
  // that, the absence of `targetLanguage` could just be "not loaded
  // yet." During the fetch-in-progress phase we report `false` to
  // avoid showing the "source-only" badge to users with non-source-only
  // projects on a slow network.
  const isSourceOnly =
    settings.hasFetched && (settings.settings.targetLanguage == null
      || settings.settings.targetLanguage === "")

  const link = useCallback(
    async (nextSourceProjectId: string): Promise<boolean> => {
      if (!projectId) {
        setError("No project loaded.")
        return false
      }
      if (!canEditLink || !jwt) {
        setError("You don't have permission to change the source link.")
        return false
      }
      setError(null)
      setIsMutating(true)
      try {
        await linkProjectToSource(projectId, nextSourceProjectId, jwt)
        if (!mountedRef.current) return true
        setSourceProjectId(nextSourceProjectId)
        // Name resolution lives outside this hook; clear so consumers
        // re-derive from their own project list.
        setSourceProjectName(undefined)
        return true
      } catch (err) {
        if (!mountedRef.current) return false
        setError(explainError(err))
        return false
      } finally {
        if (mountedRef.current) setIsMutating(false)
      }
    },
    [projectId, jwt, canEditLink],
  )

  const detach = useCallback(async (): Promise<DetachResult | null> => {
    if (!projectId) {
      setError("No project loaded.")
      return null
    }
    if (!canEditLink || !jwt) {
      setError("You don't have permission to change the source link.")
      return null
    }
    setError(null)
    setIsMutating(true)
    try {
      const result = await detachProjectFromSource(projectId, jwt)
      if (!mountedRef.current) return result
      setSourceProjectId(null)
      setSourceProjectName(undefined)
      return result
    } catch (err) {
      if (!mountedRef.current) return null
      setError(explainError(err))
      return null
    } finally {
      if (mountedRef.current) setIsMutating(false)
    }
  }, [projectId, jwt, canEditLink])

  return {
    sourceProjectId,
    sourceProjectName,
    isLinked: sourceProjectId != null,
    isSourceOnly,
    canEditLink,
    error,
    isMutating,
    link,
    detach,
  }
}
