// AQU-1561: the upstream-file checkbox list, shared by the two places that ask
// "which of this upstream's files do you want?".
//
// Both the Source & sync link flow (`ProjectSettings/LinkSourceFlow`, AQU-1559)
// and Create New Project (`ProjectCreateDialog`) ask that question, and the
// issue's requirement is that they never drift apart: one list, one check-all
// control, one set of strings. So the markup and the `projectSettings.linkSource.*`
// keys live here and both callers render this.
//
// State stays with the caller. Each flow owns when the selection is seeded and
// cleared — the link flow on entering/leaving its confirm step, the create
// dialog on the upstream changing — and both of those resets have to reach the
// rest of their own form, so this component takes the set and reports presses
// rather than holding anything.

import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { useT } from "@/lib/i18n/I18nProvider"
import { summarizeFileSelection } from "@/lib/sync/link-file-selection"
import type { LinkSourcePreviewFile } from "@/lib/sync/link-source-preview"

export interface UpstreamFileChoiceListProps {
  /** The upstream's files, in the upstream's own order. Empty renders nothing —
   *  an upstream with no files is a linkable situation with no list to show. */
  files: readonly LinkSourcePreviewFile[]
  /** The upstream file ids currently checked. */
  selectedFileIds: ReadonlySet<string>
  /** One row pressed. */
  onToggleFile: (fileId: string) => void
  /** The check-all control pressed: true = every file, false = none. */
  onToggleAll: (checked: boolean) => void
  disabled?: boolean
}

export function UpstreamFileChoiceList({
  files,
  selectedFileIds,
  onToggleFile,
  onToggleAll,
  disabled,
}: UpstreamFileChoiceListProps) {
  const t = useT()
  const { selectedCount, allSelected } = useMemo(
    () => summarizeFileSelection(files, selectedFileIds),
    [files, selectedFileIds],
  )

  if (files.length === 0) return null

  return (
    <div className="space-y-2" data-testid="upstream-file-choices">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          // A partial pick is visually distinct from "all" — the control is one
          // press away from either, so it must not read as already-all.
          indeterminate={selectedCount > 0 && !allSelected}
          disabled={disabled}
          onCheckedChange={(checked) => onToggleAll(!!checked)}
        />
        {t("projectSettings.linkSource.selectAllFiles")}
      </label>
      {/* Rows are the upstream's own order, scrolled rather than paged — an
          upstream can hold 66 books or more, and someone unchecking three of
          them should not have to hunt pages. */}
      <ul className="max-h-56 space-y-1 overflow-y-auto rounded border px-3 py-2">
        {files.map((f) => (
          <li key={f.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedFileIds.has(f.id)}
                disabled={disabled}
                onCheckedChange={() => onToggleFile(f.id)}
              />
              <span className="truncate">{f.name}</span>
              {/* The row's own clash marker, so a warning that names the files
                  has rows to point at. Never set on a brand-new project, which
                  has no files of its own to collide with. */}
              {f.clashes && (
                <Badge variant="outline" className="shrink-0 text-amber-700 dark:text-amber-300">
                  {t("projectSettings.linkSource.fileClashBadge")}
                </Badge>
              )}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
