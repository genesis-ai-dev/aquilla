/**
 * Whitespace tokenizer used for token-level evidence highlights. The primary
 * workspace search uses substring matching, not tokens.
 */
export function tokenizeText(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*?>/g, " ")
    // Unicode-aware: \w is ASCII-only, which dropped every accented or
    // non-Latin letter — most projects' source/target text tokenized to
    // nothing (same rationale as terminology/match.ts choosing \p{L}).
    // \p{M} keeps combining marks (Hebrew niqqud, Arabic harakat, Devanagari
    // vowel signs) attached instead of splitting words at every mark.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/** Strips HTML tags so text-only search isn't fooled by markup. */
export function stripTags(text: string): string {
  return (text || "").replace(/<[^>]*?>/g, " ")
}
