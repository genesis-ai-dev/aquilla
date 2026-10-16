import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  countRefusedWrites,
  discardRefusedWrites,
  refusedWritesQuery,
  retryRefusedWrites,
} from "@/lib/offline/refused-writes"

const REFUSED_TOAST_ID = "offline-refused-writes"

/**
 * Invisible mount: warns when the server has refused offline edits for good
 * (src/lib/offline/refused-writes.ts), so they don't sit unsent unnoticed.
 * Retry puts them back in the queue; Discard drops them after a confirm in
 * the same toast. Closes by itself once none are left.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineRefusedWritesNotice(): null {
  const { store } = useOfflineStore()
  const t = useT()
  const [count, setCount] = useState(0)
  // The count Discard was pressed at: a changed count needs a fresh look
  // before anything is discarded.
  const [confirmingAt, setConfirmingAt] = useState<number | null>(null)
  const confirming = confirmingAt === count

  useEffect(() => {
    if (!store) return
    const recheck = () => setCount(countRefusedWrites(store))
    recheck()
    return store.subscribe(refusedWritesQuery, recheck)
  }, [store])

  useEffect(() => {
    if (!store || count === 0) {
      toast.close(REFUSED_TOAST_ID)
      return
    }
    if (confirming) {
      toast.add({
        id: REFUSED_TOAST_ID,
        type: "error",
        timeout: 0,
        title: t("workspace.offline.refusedDiscardConfirm", { count }),
        description: (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setConfirmingAt(null)}>
            {t("workspace.offline.refusedKeep")}
          </Button>
        ),
        actionProps: {
          children: t("workspace.offline.refusedDiscard"),
          onClick: () => discardRefusedWrites(store),
        },
      })
      return
    }
    toast.add({
      id: REFUSED_TOAST_ID,
      type: "error",
      timeout: 0,
      title: t("workspace.offline.refusedToast", { count }),
      description: (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setConfirmingAt(count)}>
          {t("workspace.offline.refusedDiscard")}
        </Button>
      ),
      actionProps: {
        children: t("workspace.offline.refusedRetry"),
        onClick: () => retryRefusedWrites(store),
      },
    })
  }, [store, count, confirming, t])

  return null
}
