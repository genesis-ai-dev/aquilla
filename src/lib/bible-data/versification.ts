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

/**
 * An SBLGNT word, or (pack 1.2.0, AQU-1700) a Macula Hebrew morpheme: one
 * more digit for the morpheme, and "ה" for an implied article that Macula
 * split off ("o080010010071ה").
 */
const WORD_ID_RE = /^(?:n\d{2}(\d{3})(\d{3})\d{3}|o\d{2}(\d{3})(\d{3})\d{4}\u05D4?)$/

/**
 * The verse a pack word is in (AQU-1689). A word id is "n" + book(2) +
 * chapter(3) + verse(3) + word(3), so "n43004010024" is in JHN 4:10; an OT
 * morpheme id is "o" + the same + morpheme(1), so "o080010160052" is in
 * RUT 1:16. The people layer is keyed by word id alone, with no verse map to
 * re-key, so its mentions find their verse through this. The ref is ORG,
 * which is what `mapLayerToProject` gives every layer today; when that
 * mapping lands, map this ref through it as well.
 */
export function refOfWord(book: string, wordId: string): string | null {
  const match = WORD_ID_RE.exec(wordId)
  if (!match) return null
  const [chapter, verse] = match[1] !== undefined ? [match[1], match[2]] : [match[3], match[4]]
  return `${book} ${Number(chapter)}:${Number(verse)}`
}
