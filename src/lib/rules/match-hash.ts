// AQU-1740: a stable identity for ONE finding inside a cell's rule infraction.
//
// A waiver used to be keyed by (cell, rule) alone, so dismissing one repeated
// word hid *every* repeated-word hit in that cell — including ones the
// translator typed afterwards. Paratext's Biblical Terms "deny" is per
// occurrence, not per term, and that is the behaviour being matched here: a
// finding is additionally identified by a hash of the text that matched, so
// the waiver travels with that exact wording and a different (or newly
// introduced) match is still flagged.
//
// Why a hash of the matched text and not the span offsets: offsets shift
// whenever anything *earlier* in the cell is edited, so an offset key would
// silently drop every waiver on the next keystroke. Why not the raw matched
// text: it lands in a database primary key and in an event payload, where
// unbounded raw cell content is both a size and a confidentiality problem.
//
// The hash is NOT a security boundary — it identifies a finding, nothing more.

/**
 * The form the hash is taken over. NFC so differently-composed accents agree,
 * whitespace collapsed so a reflowed line ("the\n  the" → "the the") is still
 * the same finding, and case-folded because the checks that produce multi-span
 * infractions (repeated-word, target-forbids, terminology) are themselves
 * case-insensitive — a waiver on "Amen amen" must also cover "amen Amen".
 *
 * Exported for tests and so callers can reason about what counts as "the same
 * finding" without re-deriving the rule.
 */
export function normalizeMatchText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase()
}

/**
 * cyrb53 — two interleaved 32-bit lanes combined into 53 bits, which is the
 * widest integer `Number` represents exactly. Pure, synchronous and cheap
 * enough for the keystroke path (`crypto.subtle` is async, so it is not an
 * option here); base36 keeps the stored key ~11 characters.
 *
 * Returns `""` for text with no normalized content — see `spanMatchHash`,
 * which treats that as "this span has no finding identity".
 */
export function matchHash(matchedText: string): string {
  const s = normalizeMatchText(matchedText)
  if (s.length === 0) return ""
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
