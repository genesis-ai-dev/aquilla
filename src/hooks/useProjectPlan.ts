// AQU-1092…1098: the project's plan, for the dashboard board and inspector.
//
// Follows the app's own data convention (useProject, useOrgPortfolio): a
// useEffect + fetch with a `cancelled` flag, no query library. Writes are
// applied optimistically and rolled back on failure, because the two gestures
// this powers — picking a date, marking a unit done — should feel instant and
// are both trivially reversible.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchProjectPlan,
  setPlanUnit,
  type PlanUnit,
  type PlanUnitPatch,
} from "@/lib/sync/plan"

export type PlanStatus = "idle" | "loading" | "ready" | "error"

export interface UseProjectPlanResult {
  units: PlanUnit[]
  status: PlanStatus
  /** Validators required for a cell to count as validated, for the bars. */
  validationCount: number
  error: string | null
  refresh: () => void
  /**
   * Patch one unit. Resolves true when the server accepted it. The optimistic
   * value is already on screen by the time this is awaited; a rejection puts
   * the previous value back.
   */
  patchUnit: (patch: PlanUnitPatch) => Promise<boolean>
}

const unitKey = (fileId: string, sectionKey: string) => `${fileId}:${sectionKey}`

export function useProjectPlan(opts: {
  projectId: string | null
  lane: string
  /** Mints a project-scoped sync token; null while the session is not ready. */
  getToken: (() => Promise<string | null>) | null
  enabled?: boolean
}): UseProjectPlanResult {
  const { projectId, lane, getToken, enabled = true } = opts
  const [units, setUnits] = useState<PlanUnit[]>([])
  const [status, setStatus] = useState<PlanStatus>("idle")
  const [validationCount, setValidationCount] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Keeps a slow refetch from overwriting a newer optimistic edit.
  const generation = useRef(0)
  // The latest units, readable synchronously. A rollback has to know what the
  // row looked like BEFORE the optimistic edit, and React may run a state
  // updater after the request has already started.
  const unitsRef = useRef<PlanUnit[]>([])
  unitsRef.current = units

  useEffect(() => {
    if (!enabled || !projectId || !getToken) {
      setStatus("idle")
      setUnits([])
      return
    }
    let cancelled = false
    const gen = ++generation.current
    setStatus("loading")
    setError(null)
    void (async () => {
      try {
        const token = await getToken()
        if (cancelled || !token) return
        const body = await fetchProjectPlan(projectId, token, lane)
        if (cancelled || generation.current !== gen) return
        setUnits(body.units)
        setValidationCount(body.validationCount)
        setStatus("ready")
      } catch (err) {
        if (cancelled || generation.current !== gen) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus("error")
      }
    })()
    return () => {
      cancelled = true
    }
    // `lane` is a dependency on purpose: switching the language tab changes
    // every unit's filled/validated counts, so the board must re-read.
  }, [projectId, lane, getToken, enabled, reloadKey])

  const refresh = useCallback(() => setReloadKey((n) => n + 1), [])

  const patchUnit = useCallback(
    async (patch: PlanUnitPatch): Promise<boolean> => {
      if (!projectId || !getToken) return false
      const key = unitKey(patch.fileId, patch.sectionKey)
      const previous = unitsRef.current.find((u) => unitKey(u.fileId, u.sectionKey) === key)
      setUnits((current) =>
        current.map((u) => {
          if (unitKey(u.fileId, u.sectionKey) !== key) return u
          const next = { ...u }
          if (patch.targetDate !== undefined) next.targetDate = patch.targetDate
          if (patch.done !== undefined) {
            // Guessed provenance, replaced by the server's answer below. The
            // point is that the row moves groups immediately.
            next.doneAt = patch.done ? Date.now() : null
            next.doneBy = patch.done ? (u.doneBy ?? null) : null
          }
          return next
        }),
      )
      try {
        const token = await getToken()
        if (!token) throw new Error("no sync token")
        const saved = await setPlanUnit(projectId, token, patch, lane)
        setUnits((current) =>
          current.map((u) => (unitKey(u.fileId, u.sectionKey) === key ? saved : u)),
        )
        return true
      } catch (err) {
        // Put the row back exactly as it was; the caller surfaces the failure.
        if (previous) {
          const restore = previous
          setUnits((current) =>
            current.map((u) => (unitKey(u.fileId, u.sectionKey) === key ? restore : u)),
          )
        }
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [projectId, lane, getToken],
  )

  return { units, status, validationCount, error, refresh, patchUnit }
}
