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
//
// ---------------------------------------------------------------------------
// AQU-1423: HIDDEN CELLS LEAVE EVERY EXPORT.
//
// "Hide cell" (AQU-1422) parks a cell without deleting it — a stray heading, a
// marker that bled through import, a paragraph the client does not want
// translated. Hiding only means anything if the DELIVERED file honours it, so a
// hidden cell is omitted from every export exactly as a removed one is.
//
// It lands here, in the one scoping step, rather than in each exporter: there
// are ~20 of them, they are added regularly, and an exporter that forgot the
// predicate would ship the client's original words for a cell somebody
// deliberately parked — silently, in the delivered file. A predicate one
// function applies cannot be forgotten by the next format.
//
// TWO DIFFERENCES FROM THE VALIDATION RULE ABOVE, both deliberate:
//
//   - Hiding is NOT a mode. `validated-only` is a choice the person makes in
//     the dialog; hiding is a property of the cell, so it applies under
//     `current` too. There is no export that should contain a parked cell.
//   - Round-trip injectors CANNOT drop a paragraph from here — the package walk
//     owns that. So `scopeRoundTripCells` clears a hidden cell's translation
//     (which every injector reads as "leave the client's own words alone") and
//     docx/pptx additionally drop the paragraph through the removed-cells
//     mechanism they already have, fed by `hiddenRoundTripRemovals` below.
//     IDML keeps the original text: its engine refuses structural change by
//     design, and the export dialog says so rather than pretending otherwise.
//
// `hidden` is read off `CellData.hidden`, which the cell store copies from the
// SOURCE row's flag and never from a target row (AQU-1422) — hiding is per
// cell, not per lane. This module never re-derives it.

/** Which cells may contribute a translation to an export. */
export type ExportContentMode =
  /** Every cell's current text, with source text filling untranslated blanks. */
  | "current"
  /** Only cells meeting the project's validation threshold. */
  | "validated-only"

/** Exports open on today's behaviour; "validated only" is a deliberate choice. */
export const DEFAULT_EXPORT_CONTENT_MODE: ExportContentMode = "current"

/** The `CellData` fields this module reads.
 *
 *  `hidden` is OPTIONAL on purpose: every caller passes real `CellData`, and a
 *  cell that carries no flag is visible — which is also what every cell of a
 *  project with nothing parked looks like. */
interface ScopableCell {
  status: "empty" | "unvalidated" | "validated"
  hidden?: boolean
}

/** True when this cell meets the project's validation threshold (AQU-279). */
export function isValidatedForExport(cell: ScopableCell): boolean {
  return cell.status === "validated"
}

/**
 * True when this cell is parked with "Hide cell" (AQU-1422) and must therefore
 * not appear in any export.
 *
 * Written as an explicit `=== true` rather than a truthiness check so a row
 * that arrives from an older read path with `hidden: undefined` — every row, on
 * a project where nothing has ever been hidden — is unambiguously visible.
 */
export function isHiddenFromExport(cell: ScopableCell): boolean {
  return cell.hidden === true
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
  // AQU-1423: hidden cells go in BOTH modes — parking a cell is not a choice
  // about this download. Checked first so the identity return below still holds
  // for the overwhelmingly common file that has nothing parked.
  const hidden = cells.some(isHiddenFromExport)
  if (mode === "current") return hidden ? cells.filter((c) => !isHiddenFromExport(c)) : cells
  return cells.filter((c) => isValidatedForExport(c) && !isHiddenFromExport(c))
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
  // AQU-1423: a hidden cell contributes no translation in EITHER mode, so the
  // injector leaves the paragraph's original words alone. docx and pptx then
  // drop that paragraph outright via `hiddenRoundTripRemovals`; IDML cannot,
  // and keeps the original text (the dialog note says so).
  const contributes = (c: T): boolean =>
    !isHiddenFromExport(c) && (mode === "current" || isValidatedForExport(c))
  // Identity return for the common file: nothing parked and no validation
  // filter, so today's exports stay byte-identical.
  if (mode === "current" && cells.every(contributes)) return cells
  return cells.map((c) => (contributes(c) ? c : { ...c, translated: "" }))
}

/** What `hiddenRoundTripRemovals` hands the docx/pptx injectors. Structurally
 *  the server's `RemovedCellLocatorSource` — the same `metadata` bucket, read by
 *  the same `packageBlockLocator` — because the two mean the same thing to the
 *  package walk: this paragraph leaves the document. */
export interface HiddenCellRemoval {
  metadata: Record<string, unknown> | null
}

/**
 * Hidden cells, in the shape docx/pptx already accept for removed ones.
 *
 * Their `removedCells` option drops a package block, which is exactly what a
 * hidden cell needs: clearing the translation alone would leave the client's
 * ORIGINAL words in the delivered document, so the parked paragraph would ship
 * in the source language — the precise failure AQU-752 was on the Codex side.
 *
 * Concatenated with the server's removals rather than replacing them: a file can
 * have both, and the two lists are independent.
 */
export function hiddenRoundTripRemovals(
  cells: readonly (ScopableCell & { metadata?: Record<string, unknown> | null })[],
): HiddenCellRemoval[] {
  return cells
    .filter(isHiddenFromExport)
    .map((c) => ({ metadata: c.metadata ?? null }))
}

/**
 * Hidden cells out, and nothing else.
 *
 * For the two export paths the CONTENT MODE deliberately skips — the audio-cue
 * sibling's rows and the audio/dubbing zips, whose text is a recording's own
 * script and whose validation is a separate flag (AQU-508 / AQU-965). They must
 * still honour hiding, because that is a property of the cell rather than a
 * choice about this download. Returns the caller's array when nothing is parked.
 */
export function dropHiddenCells<T extends ScopableCell>(cells: T[]): T[] {
  return cells.some(isHiddenFromExport) ? cells.filter((c) => !isHiddenFromExport(c)) : cells
}

/** True when this file has anything parked — drives the export dialog's
 *  per-format note about what happens to it. */
export function hasHiddenCells(cells: readonly ScopableCell[]): boolean {
  return cells.some(isHiddenFromExport)
}

/** True when the server-side (USFM) export should be asked for validated text only. */
export function validatedOnly(mode: ExportContentMode): boolean {
  return mode === "validated-only"
}
