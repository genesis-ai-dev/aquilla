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
