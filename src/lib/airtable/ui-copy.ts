// Airtable's words for the shared progress-sync settings pieces (AQU-804):
// the Monday column picker, mapping table, "Add columns" dialog and linked
// view say "field" and "table" here. See src/lib/integrations/sync-ui.ts.

import type {
  AddColumnsCopy,
  ChooserCopy,
  LinkedViewCopy,
  MappingCopy,
} from "@/lib/integrations/sync-ui"

export const AIRTABLE_MAPPING_COPY: MappingCopy = {
  columnHeader: "projectSettings.airtable.fieldHeader",
  pickColumnPlaceholder: "projectSettings.airtable.pickFieldPlaceholder",
  noColumnsMapped: "projectSettings.airtable.noFieldsMapped",
}

export const AIRTABLE_CHOOSER_COPY: ChooserCopy = {
  intro: "projectSettings.airtable.chooser.intro",
  onBoard: "projectSettings.airtable.chooser.inTable",
  newColumn: "projectSettings.airtable.chooser.newField",
  alwaysIncluded: "projectSettings.airtable.chooser.alwaysIncluded",
  summaryAdds: "projectSettings.airtable.chooser.summaryAdds",
  summaryNoAdds: "projectSettings.airtable.chooser.summaryNoAdds",
  // AQU-1989 (Sam, 2026-10-20): the amber security note Monday shows under the
  // names fields, in Airtable's words — a shared base is read like a board.
  namesVisible: "projectSettings.airtable.chooser.namesVisible",
}

export const AIRTABLE_ADD_COLUMNS_COPY: AddColumnsCopy = {
  title: "projectSettings.airtable.addFieldsDialogTitle",
  confirm: "projectSettings.airtable.addFieldsConfirm",
  failed: "projectSettings.airtable.wizardAddFieldsFailed",
  notAdded: "projectSettings.airtable.wizardSomeFieldsNotAdded",
}

export const AIRTABLE_LINKED_VIEW_COPY: LinkedViewCopy = {
  changesIntro: "projectSettings.airtable.tableChangesIntro",
  changesReadOnly: "projectSettings.airtable.tableChangesReadOnly",
  structureStale: "projectSettings.airtable.structureStaleWarning",
  linkedPrefix: "projectSettings.airtable.linkedTablePrefix",
  openTarget: "projectSettings.airtable.openTable",
  syncNowPaused: "projectSettings.airtable.syncNowPausedTooltip",
  removeLinkAria: "projectSettings.airtable.removeTableLinkAriaLabel",
  mappingLabel: "projectSettings.airtable.fieldMappingLabel",
  loadingColumns: "projectSettings.airtable.loadingTableFields",
  reconfigurePlaceholder: "projectSettings.airtable.reconfigurePlaceholder",
}
