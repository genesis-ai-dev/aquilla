import { useEffect } from "react"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import { dismissAllConflicts, useConflicts } from "@/lib/offline/conflicts"

const CONFLICT_TOAST_ID = "offline-conflicts"

/**
 * Invisible mount (Phase 3) that surfaces one summary toast whenever an
 * offline write loses the AD-2 head CAS on reconnect (src/lib/offline/
 * conflicts.ts). One toast for the whole set, not one per cell — a user who
 * was offline for a while can rack up several at once, and the design calls
 * for a single dismissible notice + per-cell highlighting (ConflictIndicator)
 * rather than a stack.
 *
 * Rendered alongside the other invisible app-wide mounts in App.tsx.
 */
export function ConflictToast(): null {
  const conflicts = useConflicts()
  const t = useT()

  useEffect(() => {
    if (conflicts.size === 0) {
      toast.close(CONFLICT_TOAST_ID)
      return
    }
    toast.add({
      id: CONFLICT_TOAST_ID,
      type: "warning",
      timeout: 0,
      title: t("workspace.offline.conflictToast", { count: conflicts.size }),
      actionProps: {
        children: t("workspace.offline.conflictDismiss"),
        onClick: () => {
          dismissAllConflicts()
          toast.close(CONFLICT_TOAST_ID)
        },
      },
    })
  }, [conflicts.size, t])

  return null
}
