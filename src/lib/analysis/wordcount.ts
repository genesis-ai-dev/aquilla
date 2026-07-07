// Volume-analysis word counting (Matecat-parity run).
//
// Rules per Matecat's public documentation
// (https://guides.matecat.com/volume-analysis-page):
//   - space-delimited scripts count words;
//   - CJK text counts characters instead;
//   - URLs and numbers count as ONE word each;
//   - Unicode punctuation does not count.

const URL_RE = /(?:https?:\/\/|www\.)[^\s]+/gu
// Han, Hiragana, Katakana, Hangul — scripts counted per-character.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Count payable-analysis words for one segment of text. */
export function countWords(text: string): number {
  if (!text.trim()) return 0
  let count = 0
  // URLs count once each, then leave the token stream.
  const withoutUrls = text.replace(URL_RE, () => {
    count += 1
    return " "
  })
  // CJK characters count individually, then leave the token stream.
  const withoutCjk = withoutUrls.replace(CJK_RE, () => {
    count += 1
    return " "
  })
  for (const token of withoutCjk.split(/\s+/)) {
    // Strip Unicode punctuation/symbols; whatever remains (letters, digits,
    // marks) makes the token one word — so "1,000" or "café" count 1 and a
    // bare "—" counts 0.
    const stripped = token.replace(/[\p{P}\p{S}]+/gu, "")
    if (stripped.length > 0) count += 1
  }
  return count
}

export interface FileWordCount {
  fileId: string
  segments: number
  words: number
}

/** Aggregate raw word counts per file and total (volume-analysis shape). */
export function countProjectWords(
  files: { fileId: string; segments: { source: string }[] }[],
): { files: FileWordCount[]; totalSegments: number; totalWords: number } {
  const perFile = files.map((f) => ({
    fileId: f.fileId,
    segments: f.segments.length,
    words: f.segments.reduce((sum, s) => sum + countWords(s.source), 0),
  }))
  return {
    files: perFile,
    totalSegments: perFile.reduce((a, f) => a + f.segments, 0),
    totalWords: perFile.reduce((a, f) => a + f.words, 0),
  }
}
