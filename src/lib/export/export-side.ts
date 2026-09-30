// AQU-1451: WHICH SIDE an export writes — the target lane (today's output) or
// the curated source.
//
// Until now every exporter wrote the translation, and the monolingual ones
// filled an untranslated cell with its source text
// (`c.translated || effectiveSourceText(c)`). There was no way to get a
// source-only file at all, so a lead who had hidden cells (AQU-1422) or
// corrected source verses (Edit text) could not reuse that curated source
// anywhere — the one artifact subtitle, plain-text and markdown projects have
// no other route to (AQU-1449 covers the USFM counterpart, AQU-1452 DOCX/PPTX).
//
// Matthew's requirement (2026-09-29): exporting always offers the choice of
// source or target, and NEVER writes the source together with the target
// automatically. So the side is an explicit choice on every path, defaulting to
// Target, and the formats that carry both sides by definition (tsv, csv, xliff,
// tmx) are labelled as such rather than given a choice they cannot honour.
//
// ---------------------------------------------------------------------------
// HOW THE SOURCE SIDE IS BUILT: by rewriting `translated`, not by teaching ~20
// exporters a second code path.
//
// Every file-building exporter already resolves a cell's text through
// `cell.translated || effectiveSourceText(cell)`. Handing it cells whose
// `translated` IS the effective source text therefore produces a source-side
// file through the exporter's existing, tested serializer — cue timings, cue
// numbering, paragraph regrouping, heading levels and list markers all come out
// of the same code that builds the target file. This is the same mechanism
// `scopeRoundTripCells` (AQU-1148) already uses in the other direction, where
// clearing `translated` means "leave the client's own words alone".
//
// The alternative — a `side` parameter threaded into every exporter — would put
// the same two-line choice in twenty places and let the next format forget it,
// which is precisely the argument validation-scope.ts makes about hidden cells.
//
// TWO CONSEQUENCES, both deliberate:
//
//   - `translatedHtml` is dropped rather than translated: it is the rich-text
//     twin of the TARGET value, and carrying it alongside a source `translated`
//     would let any consumer that prefers it write translation text into a
//     source file. `originalHtml` stays untouched for the same reason it is
//     already untouched — nothing in this path reads it.
//   - The exporters' untranslated fallback becomes a no-op rather than a
//     surprise: a cell with no source text (an untranscribed media section —
//     see `effectiveSourceText`) has nothing to fall back TO, so it drops out of
//     the file exactly as an untranslated cell does today.
//
// A source export must not depend on the target lane or on anyone's validation
// work, so the caller pairs this with `dropHiddenCells` rather than
// `scopeCellsForExport`: hiding is a property of the cell and still applies,
// while "validated only" is a statement about translations and has nothing to
// say about the source side. That is what makes switching lanes leave a Source
// export byte-identical.

import type { ExportFormat } from "@/components/ExportDialog"
import { effectiveSourceText, type SourceTextCell } from "@/lib/cell-text"

/** Which side of the project an export writes. */
export type ExportSide =
  /** The active lane's translation — today's output, unchanged. */
  | "target"
  /** Each visible cell's current source text; no translation is written. */
  | "source"

/** Exports open on today's behaviour; Source is a deliberate choice. */
export const DEFAULT_EXPORT_SIDE: ExportSide = "target"

/** What the Side control can offer for a given format. */
export type SideAvailability =
  /** Both sides are selectable and both are built here. */
  | "both"
  /** The format writes both sides by definition (tsv, csv, xliff, tmx), so
   *  picking it IS the choice — no Side control, labelled "source + target". */
  | "bilingual"
  /** Target only: IDML (no source option by decision), the cast/metadata sheet
   *  and the audio deliverables, whose content is not a text side at all. */
  | "target-only"
  /** The Source side is a server / package round-trip that lands separately:
   *  USFM in AQU-1449, DOCX and PPTX in AQU-1452. The control is shown with
   *  Source disabled rather than silently absent, so the choice reads as
   *  "not yet here" instead of "not a thing". */
  | "pending"

/** The formats that carry source AND target in one file by definition. */
const BILINGUAL_FORMATS: readonly ExportFormat[] = ["tsv", "csv", "xlf", "tmx"]

/** True for a format whose output is bilingual by definition, so the format
 *  list labels it "source + target" instead of offering a Side choice. */
export function isBilingualFormat(format: ExportFormat): boolean {
  return BILINGUAL_FORMATS.includes(format)
}

/** What the Side control may offer for this format. */
export function sideAvailability(format: ExportFormat): SideAvailability {
  if (isBilingualFormat(format)) return "bilingual"
  switch (format) {
    case "txt":
    case "md":
    case "srt":
    case "vtt":
    case "plain-text-dump":
      return "both"
    case "usfm":
    case "docx":
    case "pptx":
      return "pending"
    default:
      // idml, sdbh-xml, metadata-csv, character-sheets, project-report and the
      // three audio exports.
      return "target-only"
  }
}

/** True when this format can actually produce the requested side today. */
export function canExportSide(format: ExportFormat, side: ExportSide): boolean {
  if (side === "target") return true
  return sideAvailability(format) === "both"
}

/** The minimum a cell must carry for its side to be swapped. */
type SidedCell = SourceTextCell & { translated: string; translatedHtml?: string }

/**
 * The cells an exporter should see for `side`.
 *
 * Returns the caller's array unchanged for `"target"`, so today's exports stay
 * byte-identical. For `"source"` every cell's `translated` becomes its
 * effective source text and `translatedHtml` is dropped — see the module note
 * above for why this is a rewrite rather than a per-exporter flag.
 */
export function applyExportSide<T extends SidedCell>(cells: T[], side: ExportSide): T[] {
  if (side === "target") return cells
  return cells.map((c) => {
    const { translatedHtml: _dropped, ...rest } = c
    return { ...rest, translated: effectiveSourceText(c) } as T
  })
}
