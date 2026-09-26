import { TriangleAlertIcon } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { dismissConflict, useConflicts } from "@/lib/offline/conflicts"

/**
 * Per-cell offline-conflict badge (Phase 3). Renders nothing unless
 * `cellRowKey` (the same composite id `cellRowId()` in src/lib/offline/
 * schema.ts produces) is in the live conflict set. Clicking it dismisses
 * just that one cell's conflict — the global toast (ConflictToast.tsx)
 * dismisses all of them at once.
 *
 * Not yet wired into TranslatedEditor / the cell row list: that requires
 * Phase 4's offline read path (which cell row a given render corresponds to
 * in LiveStore terms). This component is the ready-to-drop-in piece for
 * that wiring — pass it the row's `cellRowId(projectId, fileId, cellId,
 * "target")`.
 */
export function ConflictIndicator({ cellRowKey }: { cellRowKey: string }) {
  const conflicts = useConflicts()
  const t = useT()
  if (!conflicts.has(cellRowKey)) return null

  return (
    <AppTooltip content={t("workspace.offline.conflictIndicatorTooltip")}>
      <button
        type="button"
        onClick={() => dismissConflict(cellRowKey)}
        className="inline-flex items-center justify-center text-amber-600 dark:text-amber-500 hover:text-amber-700 dark:hover:text-amber-400"
        aria-label={t("workspace.offline.conflictIndicatorTooltip")}
      >
        <TriangleAlertIcon className="size-3.5" />
      </button>
    </AppTooltip>
  )
}
