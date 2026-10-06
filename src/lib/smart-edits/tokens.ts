// Smart edits — tokenizer shared by the edit miner (auth-worker), the replay
// eval (scripts/), and the editor (src/).
//
// Alias-free and DOM-free, like src/lib/completion/seams.ts, so a Worker can
// import it by relative path.
//
// A token is a run of letters/marks/digits, optionally joined by an inner
// apostrophe or hyphen ("don't", "Jabes-galaad"), or a single punctuation
// mark. Whitespace is never a token. Offsets point into the ORIGINAL string so
// a match can be underlined exactly where the user sees it.

export interface Token {
  /** Surface text as written. */
  text: string
  /** Comparison key: NFC + lower case. Never shown to a user. */
  norm: string
  start: number
  end: number
}

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]/gu

export function normalizeToken(text: string): string {
  return text.normalize("NFC").toLowerCase()
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0
    tokens.push({ text: m[0], norm: normalizeToken(m[0]), start, end: start + m[0].length })
  }
  return tokens
}

/** Join normalized tokens into a phrase key. A single space never occurs
 *  inside a token, so the join is unambiguous. */
export function phraseKey(norms: readonly string[]): string {
  return norms.join(" ")
}

/** True when the token is punctuation (no letter, mark or digit). */
export function isPunct(norm: string): boolean {
  return !/[\p{L}\p{M}\p{N}]/u.test(norm)
}
