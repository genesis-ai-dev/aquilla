// EBibleTargetReviewPanel — review screen shown before committing eBible
// verses into the target column of existing source cells.
//
// Modeled on FixReviewPanel: a per-cell list with checkboxes + bulk select,
// conflict cells highlighted (has existing target), orphan summary at the
// bottom. Only checked cells get committed.

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { EBibleMatchResult, EBibleMatchedCell } from "@/lib/import"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  translation: { title: string; id: string }
  matchResult: EBibleMatchResult
  /** Fired when the user clicks Apply; receives the set of approved cellIds. */
  onApply: (selectedCellIds: Set<string>) => void
  onCancel: () => void
}

export function EBibleTargetReviewPanel({ translation, matchResult, onApply, onCancel }: Props) {
  const t = useT()
  const { matched, orphans, unmatchedSourceCount } = matchResult

  // Default: all non-conflict cells selected; conflict cells UNselected (keep).
  const initialSelected = useMemo(
    () => new Set(matched.filter((m) => !m.hasConflict).map((m) => m.cellId)),
    [matched],
  )
  const [selected, setSelected] = useState<Set<string>>(initialSelected)

  function toggle(cellId: string) {
    const next = new Set(selected)
    if (next.has(cellId)) next.delete(cellId)
    else next.add(cellId)
    setSelected(next)
  }

  function selectAll() {
    setSelected(new Set(matched.map((m) => m.cellId)))
  }
  function selectNone() {
    setSelected(new Set())
  }
  function selectClean() {
    setSelected(new Set(matched.filter((m) => !m.hasConflict).map((m) => m.cellId)))
  }

  const conflictCount = matched.filter((m) => m.hasConflict).length
  const selectedConflictCount = matched.filter((m) => m.hasConflict && selected.has(m.cellId)).length

  return (
    <div className="flex flex-col gap-3 py-2">
      {/* Header summary */}
      <div className="space-y-1">
        <p className="text-sm font-medium">{translation.title} <span className="text-xs font-normal text-muted-foreground">({translation.id})</span></p>
        <p className="text-xs text-muted-foreground">
          {t("editor.ebible.matched", { count: matched.length.toLocaleString() })}
          {conflictCount > 0 && (
            <> · <span className="text-amber-600 dark:text-amber-400">{t("editor.ebible.conflicts", { count: conflictCount.toLocaleString() })}</span></>
          )}
          {orphans.length > 0 && (
            <> · {t("editor.ebible.orphans", { count: orphans.length.toLocaleString() })}</>
          )}
        </p>
      </div>

      {/* Bulk-select controls */}
      {matched.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t("editor.ebible.selectedCount", { selected: selected.size, total: matched.length })}
            {selectedConflictCount > 0 && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                {t("editor.ebible.willOverwrite", { count: selectedConflictCount })}
              </span>
            )}
          </p>
          <div className="flex gap-2 text-xs">
            <button type="button" className="underline text-muted-foreground hover:text-foreground" onClick={selectAll}>{t("editor.ebible.selectAll")}</button>
            <button type="button" className="underline text-muted-foreground hover:text-foreground" onClick={selectClean}>{t("editor.ebible.selectClean")}</button>
            <button type="button" className="underline text-muted-foreground hover:text-foreground" onClick={selectNone}>{t("common.none")}</button>
          </div>
        </div>
      )}

      {/* Cell list */}
      {matched.length > 0 ? (
        <ScrollArea className="h-72 rounded-md border">
          <ul className="divide-y">
            {matched.map((m) => (
              <MatchedCellRow
                key={m.cellId}
                cell={m}
                checked={selected.has(m.cellId)}
                onToggle={() => toggle(m.cellId)}
              />
            ))}
          </ul>
        </ScrollArea>
      ) : (
        <p className="rounded-md border p-4 text-sm text-muted-foreground text-center">
          {t("editor.ebible.noMatches")}
        </p>
      )}

      {/* Orphan summary */}
      {orphans.length > 0 && (
        <details className="rounded-md border p-2 text-xs">
          <summary className="select-none text-muted-foreground">
            {t("editor.ebible.orphanSummary", { count: orphans.length })}
          </summary>
          <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto pl-2">
            {orphans.slice(0, 30).map((o) => (
              <li key={o.ref} className="text-muted-foreground">
                <span className="font-mono">{o.ref}</span>
              </li>
            ))}
            {orphans.length > 30 && (
              <li className="text-muted-foreground">{t("editor.ebible.andMore", { count: orphans.length - 30 })}</li>
            )}
          </ul>
        </details>
      )}

      {/* Unmatched source cells */}
      {unmatchedSourceCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("editor.ebible.unmatched", { count: unmatchedSourceCount.toLocaleString() })}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          disabled={selected.size === 0}
          onClick={() => onApply(selected)}
        >
          {t("editor.ebible.apply", { count: selected.size.toLocaleString() })}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single matched-cell row
// ---------------------------------------------------------------------------

interface MatchedCellRowProps {
  cell: EBibleMatchedCell
  checked: boolean
  onToggle: () => void
}

function MatchedCellRow({ cell, checked, onToggle }: MatchedCellRowProps) {
  const t = useT()
  return (
    <li
      className={cn(
        "px-3 py-2 text-xs",
        cell.hasConflict && "bg-amber-50 dark:bg-amber-950/20",
        checked && cell.hasConflict && "bg-amber-100 dark:bg-amber-900/30",
      )}
    >
      <label className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          onCheckedChange={onToggle}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">{cell.ref}</span>
            {cell.hasConflict && (
              <span className="rounded px-1 py-0.5 text-[9px] font-medium bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200">
                {t("editor.ebible.conflictBadge")}
              </span>
            )}
          </div>
          {/* Show existing content (red/strikethrough) only when there's a conflict */}
          {cell.hasConflict && (
            <p className="truncate text-red-600 line-through dark:text-red-400">
              {cell.currentText}
            </p>
          )}
          <p className="truncate text-green-700 dark:text-green-400">
            {cell.incomingText}
          </p>
        </div>
      </label>
    </li>
  )
}
