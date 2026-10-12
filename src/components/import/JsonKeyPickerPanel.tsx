/**
 * AQU-525: JSON key picker — which keys of a JSON source file hold
 * translatable text.
 *
 * Shown after the user hands a `.json` (or `.arb`) file to the general
 * uploader. Waha's source strings are "JSON of varying shapes", so the picker
 * makes no assumption about the document: it lists the string leaves the
 * parser found, grouped by their container key, and the user ticks the ones to
 * translate. Everything left unticked — including string values the user
 * chose NOT to translate — stays in the document and is written back
 * untouched on export (`exportJson({ keyed: true })`).
 *
 * Nested objects and arrays are handled by construction: a leaf's path is its
 * JSON path (`app.title`, `messages[2]`, `["weird key"]`), so an array's
 * entries group under the array and a nested object's under its own key.
 */

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useT } from "@/lib/i18n/I18nProvider"
import { groupJsonLeaves, splitJsonPath, type JsonStringLeaf } from "@/lib/parsers/json-i18n"

export interface JsonKeyPickerPanelProps {
  /** Shown so the user knows which file they are configuring. */
  fileName: string
  /** Every string leaf in the document, in walk order (`listJsonStringPaths`). */
  leaves: readonly JsonStringLeaf[]
  /** Confirmed selection, as the exact leaf paths to import. */
  onConfirm: (includePaths: string[]) => void
  onCancel: () => void
}

/**
 * Leaf rows listed per key before the remainder collapses into a count. A
 * locale file can carry thousands of strings; the per-key toggle still covers
 * the ones that aren't rendered, so nothing becomes unselectable.
 */
const MAX_ROWS_PER_GROUP = 50

export function JsonKeyPickerPanel({ fileName, leaves, onConfirm, onCancel }: JsonKeyPickerPanelProps) {
  const t = useT()
  const groups = useMemo(() => groupJsonLeaves(leaves), [leaves])
  // Default: everything selected — the pre-AQU-525 behavior, so a user who
  // wants the whole file just confirms.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(leaves.map((leaf) => leaf.path)),
  )

  const allSelected = selected.size === leaves.length
  const noneSelected = selected.size === 0

  function setPaths(paths: readonly string[], include: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const path of paths) {
        if (include) next.add(path)
        else next.delete(path)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div>
        <p className="text-sm font-medium">{t("importExport.jsonKeys.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("importExport.jsonKeys.description", { fileName })}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          aria-label={t("importExport.jsonKeys.selectAll")}
          checked={allSelected}
          indeterminate={!allSelected && !noneSelected}
          onCheckedChange={(checked) => setPaths(leaves.map((leaf) => leaf.path), checked === true)}
        />
        <span aria-hidden="true">{t("importExport.jsonKeys.selectAll")}</span>
      </label>

      <ScrollArea className="max-h-72 rounded-md border">
        <div className="flex flex-col gap-3 p-3">
          {groups.map((group) => {
            const paths = group.leaves.map((leaf) => leaf.path)
            const chosen = paths.filter((path) => selected.has(path)).length
            const groupLabel = group.parent || t("importExport.jsonKeys.rootGroup")
            const hidden = group.leaves.length - MAX_ROWS_PER_GROUP
            return (
              <div key={group.parent} className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <Checkbox
                    aria-label={groupLabel}
                    checked={chosen === paths.length}
                    indeterminate={chosen > 0 && chosen < paths.length}
                    onCheckedChange={(checked) => setPaths(paths, checked === true)}
                  />
                  <span className="font-mono" aria-hidden="true">{groupLabel}</span>
                  <span className="text-muted-foreground" aria-hidden="true">
                    {t("importExport.jsonKeys.groupCount", { selected: chosen, total: paths.length })}
                  </span>
                </label>
                <div className="flex flex-col gap-1 ps-6">
                  {group.leaves.slice(0, MAX_ROWS_PER_GROUP).map((leaf) => (
                    <label key={leaf.path} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        aria-label={leaf.path}
                        checked={selected.has(leaf.path)}
                        onCheckedChange={(checked) => setPaths([leaf.path], checked === true)}
                      />
                      <span className="font-mono shrink-0" aria-hidden="true">{splitJsonPath(leaf.path).label}</span>
                      <span className="truncate text-muted-foreground" aria-hidden="true" title={leaf.value}>
                        {leaf.value}
                      </span>
                    </label>
                  ))}
                  {hidden > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("importExport.jsonKeys.moreInKey", { count: hidden })}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("importExport.jsonKeys.selectedCount", { selected: selected.size, total: leaves.length })}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            disabled={noneSelected}
            onClick={() => onConfirm(leaves.map((leaf) => leaf.path).filter((path) => selected.has(path)))}
          >
            {t("importExport.jsonKeys.confirm")}
          </Button>
        </div>
      </div>
    </div>
  )
}
