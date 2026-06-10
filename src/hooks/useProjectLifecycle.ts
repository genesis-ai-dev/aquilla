// FRO-214: Active/inactive lifecycle hook.
//
// Derives the frozen flag from the project record (isActive === false) and
// provides a toggle action that calls PATCH /api/v2/projects/:id/lifecycle.
// The freeze is client-side (fast, no extra round-trip to check) — the server
// endpoint itself also enforces role-gating.

import { useState, useCallback } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { toggleProjectLifecycle } from "@/lib/sync/cloud-projects"

export interface UseProjectLifecycleResult {
  /**
   * True when the project is frozen (isActive === false on the record).
   * Absent/true → not frozen.
   */
  isFrozen: boolean
  /**
   * Toggle the lifecycle state. Optimistically updates `isFrozen`, then
   * commits via the API. On failure, reverts and returns the error message.
   * Throws if no JWT is available.
   */
  toggle: (jwt: string) => Promise<{ ok: true } | { ok: false; message: string }>
  busy: boolean
}

/**
 * Derive isFrozen and the toggle action from a project record.
 * `projectId` + `project` must come from the same source (useProject).
 *
 * Usage:
 *   const { isFrozen, toggle, busy } = useProjectLifecycle(projectId, project)
 */
export function useProjectLifecycle(
  projectId: string,
  project: ProjectRecord | null,
  onToggled?: (isActive: boolean) => void,
): UseProjectLifecycleResult {
  // isActive absent → treat as true (backward compat with older API responses)
  const serverIsActive = project?.isActive !== false
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  // The frozen flag: prefer the optimistic value while a toggle is in flight,
  // then fall back to the server-derived value.
  const isFrozen = optimistic !== null ? !optimistic : !serverIsActive

  const toggle = useCallback(
    async (jwt: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (busy) return { ok: false, message: "toggle already in progress" }
      const nextActive = isFrozen // frozen → toggle to active; active → toggle to inactive
      // Optimistic update
      setOptimistic(nextActive)
      setBusy(true)
      try {
        await toggleProjectLifecycle(jwt, projectId, nextActive)
        onToggled?.(nextActive)
        return { ok: true }
      } catch (err) {
        // Revert on error
        setOptimistic(null)
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        setBusy(false)
        // Clear optimistic once the server has responded — next render will use
        // the fresh project record (caller should call refresh() after toggle).
        setOptimistic(null)
      }
    },
    [busy, isFrozen, projectId, onToggled],
  )

  return { isFrozen, toggle, busy }
}
