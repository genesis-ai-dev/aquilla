// useSnapshots — fetch + mutate named snapshots for a project (FRO-176).
//
// Provides: snapshots list, create, delete, restore, and a per-snapshot loader.
// Token is project-scoped (same pattern as useCellHistory / useComments).

import { useCallback, useEffect, useRef, useState } from "react"
import {
  listSnapshots,
  createSnapshot,
  deleteSnapshot,
  restoreSnapshot,
  type Snapshot,
  type RestoreResult,
  SnapshotApiError,
} from "@/lib/sync/snapshots-api"

export type { Snapshot, RestoreResult, SnapshotApiError }

export interface UseSnapshotsOptions {
  projectId: string | null
  /** Project-scoped sync-token JWT. */
  getToken?: () => Promise<string | null>
  enabled?: boolean
}

export interface UseSnapshotsResult {
  snapshots: Snapshot[]
  isLoading: boolean
  isError: boolean
  /** Re-fetch the list. */
  revalidate: () => void
  /** Create a snapshot; revalidates on success. */
  create: (name: string, description?: string) => Promise<Snapshot>
  /** Soft-delete a snapshot; revalidates on success. */
  remove: (snapshotId: string) => Promise<void>
  /** Restore a snapshot; returns the restore result summary. */
  restore: (snapshotId: string) => Promise<RestoreResult>
}

export function useSnapshots(opts: UseSnapshotsOptions): UseSnapshotsResult {
  const { projectId, getToken, enabled = true } = opts

  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const tokenRef = useRef(getToken)
  const enabledRef = useRef(enabled)
  const genRef = useRef(0)

  projectRef.current = projectId
  tokenRef.current = getToken
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    if (!enabledRef.current || !pid) {
      setSnapshots([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++genRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = tokenRef.current ? await tokenRef.current() : null
      if (!token) {
        if (genRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await listSnapshots(pid, token)
      if (genRef.current !== gen) return
      setSnapshots(rows)
      setIsLoading(false)
    } catch (err) {
      if (genRef.current !== gen) return
      console.warn("[useSnapshots] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled])

  const revalidate = useCallback(() => void doFetch(), [doFetch])

  const create = useCallback(
    async (name: string, description?: string): Promise<Snapshot> => {
      const pid = projectRef.current
      if (!pid) throw new Error("no projectId")
      const token = tokenRef.current ? await tokenRef.current() : null
      if (!token) throw new Error("no auth token")
      const snap = await createSnapshot(pid, token, name, description)
      void doFetch()
      return snap
    },
    [doFetch],
  )

  const remove = useCallback(
    async (snapshotId: string): Promise<void> => {
      const pid = projectRef.current
      if (!pid) throw new Error("no projectId")
      const token = tokenRef.current ? await tokenRef.current() : null
      if (!token) throw new Error("no auth token")
      await deleteSnapshot(pid, snapshotId, token)
      void doFetch()
    },
    [doFetch],
  )

  const restore = useCallback(
    async (snapshotId: string): Promise<RestoreResult> => {
      const pid = projectRef.current
      if (!pid) throw new Error("no projectId")
      const token = tokenRef.current ? await tokenRef.current() : null
      if (!token) throw new Error("no auth token")
      return restoreSnapshot(pid, snapshotId, token)
    },
    [],
  )

  return { snapshots, isLoading, isError, revalidate, create, remove, restore }
}
