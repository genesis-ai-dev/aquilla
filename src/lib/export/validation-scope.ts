// AQU-1148: what an export is allowed to say came out of this project.
//
// Until now every export emitted whatever text sat in each cell — human
// validated, unvalidated human draft, or untouched AI draft — and the
// monolingual exporters filled the blanks with SOURCE-language text
// (`c.translated || effectiveSourceText(c)`). A partially-translated file
// therefore left the app as a seamless-looking document in which approved
// translation, unreviewed draft and untranslated source were indistinguishable
// to the publisher, typesetter or reviewer who received it.
//
// This module is the one place that decides which cells may contribute a
// translation to an export. Two shapes, because the two families of exporter
// mean different things by "leave this one out":
//
//   - `scopeCellsForExport` — the text exporters that BUILD a file from the
//     cell array (txt, md, srt, vtt, csv, tsv, xliff, tmx, …). Dropping the
//     cell is a real omission: it never reaches the `|| effectiveSourceText`
//     fallback, so no source-language filler can appear in its place.
//   - `scopeRoundTripCells` — the exporters that INJECT translations into the
//     client's own uploaded package (docx, pptx, idml). Their document skeleton
//     is the client's; a dropped cell would have to be either an unchanged
//     paragraph or a deleted one, and `removedCells` already owns deletion
//     (AQU-1068). So a non-qualifying cell is passed through with its
//     translation cleared: the exporter leaves that paragraph's ORIGINAL words
//     alone, exactly as it already does for an untranslated one.
//
// "Validated" is read off `CellData.status`, which the cell store derives from
// the target row's server-owned `validated` flag (falling back to the
// project's `validationCount` threshold) — the one authoritative definition,
// per AQU-279. This module never re-derives it.
//
// USFM is not here: that export runs server-side, and its plan applies the
// same rule in SQL (`sync-worker/src/events/usfm-export-plan.ts`).

/** Which cells may contribute a translation to an export. */
export type ExportContentMode =
  /** Every cell's current text, with source text filling untranslated blanks. */
  | "current"
  /** Only cells meeting the project's validation threshold. */
  | "validated-only"

/** Exports open on today's behaviour; "validated only" is a deliberate choice. */
export const DEFAULT_EXPORT_CONTENT_MODE: ExportContentMode = "current"

/** The `CellData` fields this module reads. */
interface ScopableCell {
  status: "empty" | "unvalidated" | "validated"
}

/** True when this cell meets the project's validation threshold (AQU-279). */
export function isValidatedForExport(cell: ScopableCell): boolean {
  return cell.status === "validated"
}

/**
 * The cells a file-building text exporter should see.
 *
 * Under `validated-only` a non-validated cell is OMITTED rather than blanked,
 * so it cannot come back as source-language filler through the exporters'
 * `translated || effectiveSourceText(cell)` fallback.
 *
 * Returns the same array instance under `current`, so today's exports stay
 * byte-identical and a fully-validated file exports identically in both modes.
 */
export function scopeCellsForExport<T extends ScopableCell>(
  cells: T[],
  mode: ExportContentMode,
): T[] {
  if (mode === "current") return cells
  return cells.filter(isValidatedForExport)
}

/**
 * The cells a round-trip injector (docx / pptx / idml) should see.
 *
 * Under `validated-only` a non-validated cell keeps its place in the array —
 * the package's paragraphs are located through it — but carries no
 * translation, which every injector already reads as "leave the client's own
 * words alone". Cleared as a COPY: the caller's array feeds the fidelity
 * warnings and the IDML telemetry too, and neither should see a blanked cell.
 */
export function scopeRoundTripCells<T extends ScopableCell & { translated: string }>(
  cells: T[],
  mode: ExportContentMode,
): T[] {
  if (mode === "current") return cells
  return cells.map((c) => (isValidatedForExport(c) ? c : { ...c, translated: "" }))
}

/** True when the server-side (USFM) export should be asked for validated text only. */
export function validatedOnly(mode: ExportContentMode): boolean {
  return mode === "validated-only"
}
