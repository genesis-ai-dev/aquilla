// ORG → project versification for Bible Knowledge Pack data (AQU-1686).
//
// The pack keys verses in ORG versification (the Macula/original-language
// scheme). A project may number some verses differently (ENG, LXX, VUL), so
// pack data must be moved onto the project's numbering when it loads. The
// pack client calls this hook on every layer it hands out.
//
// TODO(AQU-1685): map through the FRVT (Copenhagen Alliance) tables in
// ~/frontierrnd/versification-tool, using the project's versification code
// (today only recorded from Paratext imports). Re-key each layer's `verses`
// (text, structure, voices) through the mapping, and merge verses that map
// onto one project verse. Until then this is the identity, which is exact for
// every verse the schemes number alike.

/** A layer, from ORG into the project's versification. */
export function mapLayerToProject<T>(layer: T): T {
  return layer
}

const WORD_ID_RE = /^n(\d{2})(\d{3})(\d{3})\d{3}$/

/**
 * The verse a pack word is in (AQU-1689). A word id is "n" + book(2) +
 * chapter(3) + verse(3) + word(3), so "n43004010024" is in JHN 4:10. The
 * people layer is keyed by word id alone, with no verse map to re-key, so its
 * mentions find their verse through this. The ref is ORG, which is what
 * `mapLayerToProject` gives every layer today; when that mapping lands, map
 * this ref through it as well.
 */
export function refOfWord(book: string, wordId: string): string | null {
  const match = WORD_ID_RE.exec(wordId)
  if (!match) return null
  return `${book} ${Number(match[2])}:${Number(match[3])}`
}
