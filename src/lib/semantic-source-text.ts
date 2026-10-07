/**
 * The SEMANTIC source-text rule (SUB-28 / AQU-646), as a dependency-free leaf.
 *
 * Extracted from `lib/cell-text.ts` for AQU-1231: the Agent API's
 * term-consistency read runs the SAME scan the in-app "Check file" pass runs
 * (`lib/check/term-consistency-scan.ts`), and that scan needs this rule. The
 * scan and the sync-worker both import this module directly, so there is one
 * implementation rather than a server-side copy that can drift from the
 * numbers the UI shows.
 *
 * This file must stay import-free (no `@/` aliases, no types from modules that
 * use them): sync-worker's tsconfig has no path aliases, so anything reachable
 * from `sync-worker/src/**` may only use relative imports of alias-free files.
 *
 * `cell-text.ts`'s `effectiveSourceText` remains the typed entry point for SPA
 * callers (it keeps the `SegmentMedium` type); it delegates here.
 */

/** Structural subset of a source cell this rule reads. */
export interface SemanticSourceCell {
  /** `"text"` (or absent) for authored cells, `"media"` for imported media. */
  medium?: string | null
  transcription?: string | null
  original: string
}

/**
 * A cell's semantic source text: imported media sections speak through their
 * transcript — `original` holds the import FILENAME, which is never legitimate
 * source text, so an untranscribed section has NO source text (empty string;
 * callers' trim guards skip it).
 */
export function semanticSourceText(cell: SemanticSourceCell): string {
  if ((cell.medium ?? "text") !== "media") return cell.original
  return cell.transcription?.trim() ? cell.transcription : ""
}
