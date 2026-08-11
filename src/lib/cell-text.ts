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
