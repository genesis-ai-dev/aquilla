/**
 * Whitespace tokenizer used for token-level evidence highlights. The primary
 * workspace search uses substring matching, not tokens.
 */
export function tokenizeText(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*?>/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** Strips HTML tags so text-only search isn't fooled by markup. */
export function stripTags(text: string): string {
  return (text || "").replace(/<[^>]*?>/g, " ")
}
