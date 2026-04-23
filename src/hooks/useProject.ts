import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject, updateProject } from "@/lib/store/project-index"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { minimalProjectRecord, resolveCloudProject } from "@/lib/sync/cloud-projects"

export type ProjectLoadStatus =
  | "loading"
  | "ready"
  | "not-found" // server returned 403/404, or unreachable while signed-out
  | "no-session" // no jwt to fetch from server and no IDB copy

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [status, setStatus] = useState<ProjectLoadStatus>("loading")
  const hasLoaded = useRef(false)
  const { session } = useFrontierSession()

  const refresh = useCallback(() => {
    // Only show the loading state on the first fetch. Subsequent refreshes
    // (e.g. after sync) keep the stale project visible so the editor doesn't
    // unmount — which would reset scroll position and Y.Doc bindings.
    if (!hasLoaded.current) setStatus("loading")

    let cancelled = false
    ;(async () => {
      const cached = await getProject(projectId)
      if (cancelled) return

      // If we have a cloud-hydrated record (syncRole set) with an empty
      // files list, treat it as a stale stub and refresh from the server.
      // Earlier hydrations produced these before the list endpoint returned
      // files inline. Also catches the legitimate "brand new empty project"
      // case — extra fetch per mount is acceptable.
      const isStaleStub = Boolean(
        cached && cached.syncRole && (cached.files?.length ?? 0) === 0
      )

      if (cached && !isStaleStub) {
        setProject(cached)
        setStatus("ready")
        hasLoaded.current = true
        return
      }
      // IDB miss (or stale stub) — try the server so a pasted URL resolves
      // on a fresh device and stubs get backfilled with their file list.
      if (!session?.jwt) {
        setProject(cached ?? null)
        setStatus(cached ? "ready" : "no-session")
        hasLoaded.current = true
        return
      }
      const state = await resolveCloudProject(projectId, session.jwt)
      if (cancelled) return
      if (!state) {
        setProject(cached ?? null)
        setStatus(cached ? "ready" : "not-found")
        hasLoaded.current = true
        return
      }
      const hydrated = minimalProjectRecord(state)
      await updateProject(hydrated)
      if (cancelled) return
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

  return { project, status, loading: status === "loading", refresh }
}
