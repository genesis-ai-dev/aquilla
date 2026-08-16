import type { SegmentMedium } from "@/lib/sync/cells-read-types"

/**
 * Extract human-readable plain text from a stored cell value.
 * Some rows wrap the text as JSON, e.g. `{"value":"Hello"}`.
 */
export function cellTextForDisplay(raw: string | undefined | null): string {
  const text = raw ?? ""
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return text

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      parsed &&
      typeof parsed === "object" &&
      "value" in parsed &&
      typeof (parsed as { value: unknown }).value === "string"
    ) {
      return (parsed as { value: string }).value
    }
  } catch {
    // Not JSON — return the original string.
  }

  return text
}

/** Truncate display text with an ellipsis when it exceeds `maxLen`. */
export function truncateCellText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + "…"
}

/** Minimal structural shape — several consumers (completion corpus, discourse
 *  windows, the search index) operate on subsets of CellData. */
export interface SourceTextCell {
  medium?: SegmentMedium | null
  transcription?: string
  original: string
}

/**
 * The cell's SEMANTIC source text (SUB-28 / AQU-646): imported media sections
 * speak through their transcript — `original` holds the import FILENAME,
 * which is never legitimate source text, so an untranscribed section has NO
 * source text (empty string; callers' existing trim guards skip it). Every
 * AI/semantic consumer (completion prompts + example corpus + search index,
 * TTS prompt context, source-pattern rules/checks) reads through this, and so
 * does every EXPORTER (a document leaving the app must never carry a filename
 * as source text — decision 2026-08-05: transcription when present, blank
 * when not). Display code deliberately does NOT — on screen the filename is
 * a useful placeholder.
 */
export function effectiveSourceText(cell: SourceTextCell): string {
  if ((cell.medium ?? "text") !== "media") return cell.original
  return cell.transcription?.trim() ? cell.transcription : ""
}

/** `SourceTextCell` plus the HTML twin of `original`. */
export interface SourceEditCell extends SourceTextCell {
  originalHtml?: string
}

/** True when this cell's source lane is a media section's transcript. */
function isMediaSection(cell: SourceTextCell): boolean {
  return (cell.medium ?? "text") === "media"
}

/**
 * What the inline SOURCE editor must open with (AQU-847).
 *
 * The read surface has always shown a media section's transcript (falling back
 * to the filename only as a placeholder), but the editor seeded itself from
 * `original` — so clicking the pencil on a transcribed section swapped the
 * transcript for the file's title, and committing wrote that title in. A media
 * section therefore seeds from its transcript, with NO html: a transcript is
 * plain text, and `originalHtml` (when set) belongs to the filename.
 */
export function sourceEditorSeed(cell: SourceEditCell): { text: string; html: string | undefined } {
  if (!isMediaSection(cell)) return { text: cell.original, html: cell.originalHtml }
  return { text: cell.transcription ?? "", html: undefined }
}

/**
 * Which fields a source edit persists (AQU-847).
 *
 * For a media section the typed text is a TRANSCRIPT correction: it lands on
 * `transcription` — the field `effectiveSourceText` reads, and so export and
 * every AI step with it — while `value`/`valueHtml` are resent unchanged so
 * the import filename survives as provenance. Ordinary text cells are
 * untouched: their edit is still a plain `value`/`valueHtml` commit.
 */
export function sourceCommitFields(
  cell: SourceEditCell,
  edited: { value: string; valueHtml?: string },
): { value: string; valueHtml?: string; transcription?: string } {
  if (!isMediaSection(cell)) return { value: edited.value, valueHtml: edited.valueHtml }
  return { value: cell.original, valueHtml: cell.originalHtml, transcription: edited.value }
}

/**
 * The source text the row DISPLAYS (AQU-847), given any optimistic draft.
 *
 * Media sections never render `originalHtml` — once a source commit had landed
 * it made the filename permanently shadow the transcript. They show the draft,
 * then the transcript, then the filename placeholder.
 */
export function displayedSourceText(cell: SourceEditCell, draftValue: string | undefined): string {
  if (draftValue !== undefined) return draftValue
  if (!isMediaSection(cell)) return cell.original
  return cell.transcription?.trim() ? cell.transcription : cell.original
}

/**
 * The projected value a source edit's optimistic draft reconciles against
 * (AQU-847) — `transcription` for a media section, `original` otherwise.
 * Comparing a media draft to `original` left the draft pinned forever.
 */
export function projectedSourceValue(cell: SourceEditCell): string {
  return (isMediaSection(cell) ? cell.transcription : cell.original) ?? ""
}
