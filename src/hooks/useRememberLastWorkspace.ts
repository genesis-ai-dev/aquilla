import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { rememberLastWorkspace } from "@/lib/offline/last-workspace"

/** Desktop: records the open editor route for OfflineLaunchResume. */
export function useRememberLastWorkspace(projectId: string | undefined, username: string | null | undefined): void {
  const { pathname, search } = useLocation()
  useEffect(() => {
    if (!projectId || !username || !isTauriRuntime()) return
    if (!pathname.startsWith(`/project/${projectId}/`)) return
    rememberLastWorkspace(username, { projectId, path: pathname + search })
  }, [projectId, username, pathname, search])
}
