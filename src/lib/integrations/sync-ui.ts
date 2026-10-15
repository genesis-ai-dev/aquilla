// What the progress-sync settings UI needs to know about a provider (AQU-804).
//
// The column picker, the mapping table and editor, the "Add columns" dialog
// and the linked view were built for Monday (AQU-506/1770). Airtable reuses
// them: the metrics, groups and rules are the same, only the provider's field
// types and its words differ ("column on your board" vs "field in your
// table"). Each shared component takes a ColumnProfile and its copy keys,
// defaulting to Monday's, so Monday's call sites are unchanged.

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { MondayMetricKey } from "@/lib/monday/types"

/** The provider's column (field) types, as the shared components read them. */
export interface ColumnProfile {
  /** Every column Aquilla can create, in picker order: its metric, title and provider type. */
  catalog: ReadonlyArray<{ metric: MondayMetricKey; title: string; type: string }>
  /** Which provider column types each metric can write. */
  writableTypesByMetric: Record<MondayMetricKey, readonly string[]>
  /** Column types nothing can write (kept out of every picker). */
  readOnlyTypes: ReadonlySet<string>
}

/** Words in the mapping table and editor. */
export interface MappingCopy {
  /** Header of the provider-column column ("Monday column"). */
  columnHeader: MessageKey
  pickColumnPlaceholder: MessageKey
  noColumnsMapped: MessageKey
}

export const MONDAY_MAPPING_COPY: MappingCopy = {
  columnHeader: "projectSettings.monday.columnHeader",
  pickColumnPlaceholder: "projectSettings.monday.pickColumnPlaceholder",
  noColumnsMapped: "projectSettings.monday.noColumnsMapped",
}

/**
 * Words in the column picker. `summaryAdds` / `summaryNoAdds` get `{count}`,
 * `{uses}` and the target's name as `{board}`.
 */
export interface ChooserCopy {
  intro: MessageKey
  onBoard: MessageKey
  newColumn: MessageKey
  alwaysIncluded: MessageKey
  summaryAdds: MessageKey
  summaryNoAdds: MessageKey
}

export const MONDAY_CHOOSER_COPY: ChooserCopy = {
  intro: "projectSettings.monday.chooser.intro",
  onBoard: "projectSettings.monday.columnPickerOnBoard",
  newColumn: "projectSettings.monday.chooser.newColumn",
  alwaysIncluded: "projectSettings.monday.chooser.alwaysIncluded",
  summaryAdds: "projectSettings.monday.chooser.summaryAdds",
  summaryNoAdds: "projectSettings.monday.chooser.summaryNoAdds",
}

/** Words in the "Add columns" dialog on a linked board or table. */
export interface AddColumnsCopy {
  title: MessageKey
  /** `{count}`. */
  confirm: MessageKey
  /** `{reason}`. */
  failed: MessageKey
  /** `{columns}`, `{reason}`. */
  notAdded: MessageKey
}

export const MONDAY_ADD_COLUMNS_COPY: AddColumnsCopy = {
  title: "projectSettings.monday.addColumnsDialogTitle",
  confirm: "projectSettings.monday.addColumnsConfirm",
  failed: "projectSettings.monday.wizardAddColumnsFailed",
  notAdded: "projectSettings.monday.wizardSomeColumnsNotAdded",
}

/** Words in the linked view (status row, "structure changed" banner, mapping). */
export interface LinkedViewCopy {
  changesIntro: MessageKey
  changesReadOnly: MessageKey
  structureStale: MessageKey
  linkedPrefix: MessageKey
  openTarget: MessageKey
  syncNowPaused: MessageKey
  removeLinkAria: MessageKey
  mappingLabel: MessageKey
  loadingColumns: MessageKey
  reconfigurePlaceholder: MessageKey
}

export const MONDAY_LINKED_VIEW_COPY: LinkedViewCopy = {
  changesIntro: "projectSettings.monday.boardChangesIntro",
  changesReadOnly: "projectSettings.monday.boardChangesReadOnly",
  structureStale: "projectSettings.monday.structureStaleWarning",
  linkedPrefix: "projectSettings.monday.linkedBoardPrefix",
  openTarget: "projectSettings.monday.overviewOpenBoard",
  syncNowPaused: "projectSettings.monday.syncNowPausedTooltip",
  removeLinkAria: "projectSettings.monday.removeBoardLinkAriaLabel",
  mappingLabel: "projectSettings.monday.columnMappingLabel",
  loadingColumns: "projectSettings.monday.loadingBoardColumns",
  reconfigurePlaceholder: "projectSettings.monday.reconfigurePlaceholder",
}
