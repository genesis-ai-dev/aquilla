// Registry of partner-specific import sources. The open-source build replaces
// this file with an empty registry and excludes the partner module directories,
// so the import dialog degrades cleanly to its built-in sources.
import type { PartnerImportSource } from "./types"
import { biblicaSource } from "./biblica/source"

export const PARTNER_IMPORT_SOURCES: PartnerImportSource[] = [biblicaSource]

export type { PartnerImportSource, PartnerImportPanelProps } from "./types"
