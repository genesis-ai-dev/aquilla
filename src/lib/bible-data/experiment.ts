// The Bible data experiment (AQU-1685): when Bible data surfaces may render.
//
// Two conditions, both required:
//   • the device-local "Bible data enrichments" switch in Project settings →
//     Experimental (`FLAGS.bibleData`, off by default). Device-local like every
//     registry flag: turning it on here never changes a collaborator's app.
//   • a Bible is open: the same test that lets the Parallel Bibles panel appear
//     (the editor is the center surface and its file has scripture sections).
//
// With the switch off the app is as it was before the Bible Knowledge Pack:
// the settings card is the old "Bible resources" card and nothing is fetched
// from the pack. The project-wide `bibleEnrichments` choices are untouched, so
// the server (autopilot, agent checks) still reads them; those surfaces have
// their own opt-ins (`autopilotEnabled`, the default-off "Autopilot uses Bible
// data" enrichment).

import { isFlagEnabled } from "@/lib/features/flags"
import { fileHasSections, type FileReference, type ProjectRecord } from "@/lib/parsers/types"

export const BIBLE_DATA_FLAG = "bibleData"

/** Is the Bible data experiment switched on for this project on this device? */
export function isBibleDataExperimentOn(
  project: Pick<ProjectRecord, "experimentalFlags"> | null | undefined,
): boolean {
  return !!project && isFlagEnabled(project, BIBLE_DATA_FLAG)
}

/**
 * Is a Bible open? The Parallel Bibles panel's condition (AQU-1316): the
 * editor is the center surface, on a file with scripture sections.
 */
export function isBibleOpen(
  centerSurface: string,
  activeFile: Pick<FileReference, "type" | "hasScriptureContent"> | null | undefined,
): boolean {
  return centerSurface === "editor" && !!activeFile && fileHasSections(activeFile)
}
