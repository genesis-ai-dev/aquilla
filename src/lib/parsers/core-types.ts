// Pure, dependency-light types for the worker-safe parse core.
//
// Everything in this module (and its single import, shared/import-contract) is
// plain data typing — no React, no DOM, no `@/` aliases — so the DOM-free
// parsers can be imported by non-browser TypeScript programs (the import parse
// Web Worker AND the sync-worker's Agent API import-parse route). types.ts
// re-exports these names, so existing SPA imports of "@/lib/parsers/types"
// are unaffected. Do NOT add imports here that reach outside shared/.

import type { ImportMilestone, ImportSourceLocator, SourceArtifactFormat } from "../../../shared/import-contract"

export type CellType =
  | "text"
  | "heading"
  | "list"
  | "blockquote"
  | "cue"
  | "verse"
  | "paratext"

export interface SourceLocation {
  file: string       // e.g. "word/document.xml", "ppt/slides/slide3.xml"
  blockPath: string  // indexed path to block, e.g. "w:p[2]" or "p:sp[1]/p:txBody/a:p[3]"
}

export interface TranslatableString {
  id: string
  original: string
  originalHtml?: string
  translated: string
  /** Rich target initialized by format-aware parsers. IDML uses this for its
   * protected empty slot anchors even before any translated words exist. */
  translatedHtml?: string
  context: string
  group: string
  /** Optional section label for navigation/progress. USFM/ebible set this to "BOOK CHAPTER" (e.g. "GEN 1"). */
  section?: string
  /** Explicit semantic milestone supplied by a specialized parser. The shared
   * planner validates/fills this into every normalized import unit. */
  milestone?: ImportMilestone
  /**
   * Semantic tags external to cell identity. For scripture, the verse ref(s) this cell represents,
   * e.g. ["LUK 1:1"] or ["LUK 1:1", "LUK 1:2"] for a verse range. Mirrors the codex-editor
   * extension's `metadata.data.globalReferences`. Empty/omitted for non-scripture content.
   * Section labels in the sidebar are derived from these when present.
   */
  globalReferences?: string[]
  /** Cue start/end in seconds, parsed from a subtitle timestamp line. Present
   *  only for `type: "cue"` strings from VTT/SRT import; drives `start_ms`/
   *  `end_ms` persistence. */
  start?: number
  end?: number
  /** Speaker extracted from a `<v Name>` VTT voice tag, if present. Maps to a
   *  Cast member on import. */
  speaker?: string
  /** Timeline-segment-model: primary content kind. Absent ⇒ 'text'. Set to
   *  'media' only by the audio/video media-import path (Part B). */
  medium?: "text" | "media"
  /** D1: true on the first cell of a paragraph block. Absent/false = continuation.
   *  Drives paragraph grouping for multi-cell draft operations. */
  paragraphStart?: boolean
  /**
   * Extensible per-cell metadata bucket, mirrored through the import path into
   * `BulkImportCell.metadata` → `source.cell.create` payload → `cells.metadata`
   * (JSONB). OBS populates `{ attachments: [{ type: "image", url, alt }] }` —
   * one frame's reference image per cell. Future attachment kinds (gif/video/
   * audio) reuse the same bucket without a schema change. Absent for content
   * with no attachments.
   */
  metadata?: Record<string, unknown>
  type: CellType
  sourceLocation?: SourceLocation
  /** Exact format locator when a package-block locator would lose identity. */
  sourceLocator?: ImportSourceLocator
}

/**
 * One parsed file emitted by the worker-safe text parse core
 * (`parse-text-formats.ts`). Structurally a subset of `ImportResult`
 * (../import.ts) — every extra `ImportResult` field is optional, so a
 * `ParsedTextFileResult` is assignable wherever an `ImportResult` is expected.
 * Declared HERE (a pure type module) so the parse core never type-imports
 * import.ts, whose DOM-bound parser imports would drag `DOMParser` into
 * non-browser TypeScript programs (the sync-worker reuses the parse core).
 */
export interface ParsedTextFileResult {
  name: string
  strings: TranslatableString[]
  /** Raw source text for round-trip-fidelity formats (USFM today). */
  rawSource?: string
  rawSourceFormat?: SourceArtifactFormat
}

/**
 * Structural subset of the workspace `CellData` (src/hooks/useCells.ts)
 * consumed by the text-format export rebuilders (exportPo / exportProperties /
 * exportJson). Kept here (pure) so those parser modules never type-import the
 * React hook module — `CellData[]` remains assignable at every call site.
 */
export interface ExportCellFields {
  original: string
  translated: string
  context: string
  group: string
}

