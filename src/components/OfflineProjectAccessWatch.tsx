import { useEffect, useRef } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { getOfflineQueueDepth, removeOfflineProject } from "@/lib/offline/download"
import { useUnavailableProjects } from "@/lib/offline/project-access"
import { tables } from "@/lib/offline/schema"

const toastId = (projectId: string): string => `offline-project-unavailable:${projectId}`

/**
 * Invisible mount: warns when the server stops letting this device sync a
 * downloaded offline project — deleted, access removed, archived, or frozen
 * (see src/lib/offline/project-access.ts). One sticky toast per project; it
 * closes by itself if access comes back. Offers to remove the offline copy
 * only when nothing is queued, since queued edits can't reach the server now
 * and removing the copy would discard them.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineProjectAccessWatch(): null {
  const { store } = useOfflineStore()
  const unavailable = useUnavailableProjects()
  const t = useT()
  const shown = useRef(new Set<string>())

  useEffect(() => {
    if (!store) return
    const current = new Set(unavailable)
    for (const projectId of shown.current) {
      if (current.has(projectId)) continue
      toast.close(toastId(projectId))
      shown.current.delete(projectId)
    }
    for (const projectId of current) {
      if (shown.current.has(projectId)) continue
      shown.current.add(projectId)
      const project = store.query(tables.projects.select().where({ id: projectId }).first())
      const name = project?.name ?? projectId
      const queued = getOfflineQueueDepth(store, projectId)
      toast.add({
        id: toastId(projectId),
        type: "error",
        timeout: 0,
        title: t("workspace.offline.projectUnavailableToast", { name }),
        description:
          queued > 0
            ? t("workspace.offline.projectUnavailableQueued", { count: queued })
            : t("workspace.offline.projectUnavailableHint"),
        ...(queued > 0
          ? {}
          : {
              actionProps: {
                children: t("workspace.offline.projectUnavailableRemove"),
                onClick: () => {
                  // Re-checked: an edit may have been queued since the toast opened.
                  const result = removeOfflineProject(store, projectId)
                  if (!result.ok && result.reason === "queue-not-empty") {
                    toast.add({
                      type: "error",
                      title: t("org.projectOverview.offlineRemoveBlocked", { count: result.queueDepth }),
                    })
                    return
                  }
                  toast.close(toastId(projectId))
                },
              },
            }),
      })
    }
  }, [store, unavailable, t])

  return null
}
