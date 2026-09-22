// AQU-1278: the plan board's "In order" arrangement, in FOLDERS.
//
// Sam (2026-09-17): in order, the rows should still live in at least one
// collapsible group, and where a project keeps its files in folders — The
// Chosen's episodes by season — those folders should be the groups.
//
// THE FOLDERS ARE THE SIDEBAR'S FOLDERS, decided by the sidebar's own rule
// (`groupByCorpus`): a file's corpus marker names its folder; a Bible book
// with no marker falls to its testament by book code; anything else with no
// marker is "Ungrouped". Same rule, same labels, so the board and the editor
// never disagree about where a file lives. What this module adds is the
// plan's two differences: rows inside a folder keep the PLAN's order (import
// sequence, canonical for a Bible — the order the server already returned
// them in), not the sidebar's alphabetical one; and a project with no folders
// at all still gets ONE group, so Collapse all has something to fold and the
// in-order board is never a bare list.

import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { planUnitId, planUnitLabel, type PlanUnit } from "./plan-status"

export interface PlanFolderGroup {
  /**
   * Stable identity — the raw marker, "OT" / "NT", the sidebar's "Ungrouped"
   * sentinel, or "All" for the one-group case. Keys the fold, so it must
   * never be a translated string.
   */
  key: string
  /** The folder's own name, untranslated; null when `labelKey` carries the text. */
  label: string | null
  /** Catalog key for the synthetic groups ("Ungrouped", "All files"). */
  labelKey: MessageKey | null
  units: PlanUnit[]
}

/** The key of the single group a project with no folders gets. */
export const ALL_UNITS_FOLDER_KEY = "All"

export function groupPlanUnitsByFolder(units: readonly PlanUnit[]): PlanFolderGroup[] {
  // The plan's own order, to restore after the sidebar rule has sorted the
  // members its way.
  const position = new Map(units.map((u, i) => [planUnitId(u), i]))
  const byPlanOrder = (a: PlanUnit, b: PlanUnit) =>
    (position.get(planUnitId(a)) ?? 0) - (position.get(planUnitId(b)) ?? 0)

  const groups = groupByCorpus(
    units.map((unit) => ({
      unit,
      name: planUnitLabel(unit),
      corpusMarker: unit.corpusMarker ?? undefined,
      // A book unit IS its book; a file-grain unit borrows the file's code.
      // Either lets the sidebar rule find the testament.
      bookCode:
        (unit.sectionKey && isKnownBookCode(unit.sectionKey) ? unit.sectionKey : null)
        ?? unit.fileBookCode
        ?? undefined,
      type: unit.fileKind ?? undefined,
    })),
  )

  const folders: PlanFolderGroup[] = groups.map((g) => ({
    key: g.label,
    label: g.labelKey ? null : g.label,
    labelKey: g.labelKey ?? null,
    units: g.files.map((f) => f.unit).sort(byPlanOrder),
  }))

  // Nothing has a folder: one group for everything, named for what it holds.
  // "Ungrouped" as the sole header would tell a reader something is missing.
  if (folders.length === 1 && folders[0].labelKey) {
    return [{
      key: ALL_UNITS_FOLDER_KEY,
      label: null,
      labelKey: "org.projectOverview.plan.folderAll",
      units: folders[0].units,
    }]
  }
  return folders
}
