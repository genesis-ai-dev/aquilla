import { useEffect } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { NewerOfflineDataError } from "@/lib/offline/generation-guard"

const NEWER_OFFLINE_DATA_TOAST_ID = "offline-newer-data"

/**
 * Invisible mount: tells the user when this build left the device's offline
 * data alone because a newer build wrote it (src/lib/offline/generation-guard.ts).
 * The app keeps working online meanwhile — edits go through the IndexedDB
 * outbox — and DesktopUpdatePrompt offers the update, which brings the data back.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function NewerOfflineDataNotice(): null {
  const { error } = useOfflineStore()
  const t = useT()
  const refused = error instanceof NewerOfflineDataError

  useEffect(() => {
    if (!refused) return
    toast.add({
      id: NEWER_OFFLINE_DATA_TOAST_ID,
      type: "warning",
      timeout: 0,
      title: t("workspace.offline.newerDataToast"),
    })
  }, [refused, t])

  return null
}
