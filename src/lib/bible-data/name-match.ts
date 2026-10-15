// How much a Greek name looks like a word in a Latin-script text (AQU-1694).
//
// Bridge 1 uses it for one Who's Who constraint: a Greek proper noun the
// statistics left without a capitalized partner gets the capitalized source
// word that is spelled like it ("Ἰησοῦς" and "Jesus", "Ναθαναήλ" and
// "Nathanael", "Καφαρναούμ" and "Capernaum"). Names anchor every participant
// thread, and a rare name is exactly where a co-occurrence model has least to
// go on.
//
// The comparison is deliberately rough: transliterate the Greek, fold both
// spellings to a key where the usual English and Romance spellings of Greek
// sounds meet (c/k, ph/f, th/t, ch/k, j/i, y/i, w/u, no h, no doubled
// letters), then take a normalized edit distance, also against the Greek stem
// without its case ending. Non-Latin scripts score 0, so the constraint simply
// does not fire there.

const GREEK_LETTERS: Readonly<Record<string, string>> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "e", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m",
  ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "u", φ: "f", χ: "ch", ψ: "ps", ω: "o",
}

const ROUGH_BREATHING = "̔"
const isMark = (c: string) => /\p{M}/u.test(c)

/** A rough Latin spelling of a Greek word, for comparison only: "Ἰησοῦς" → "iesus". */
export function transliterateGreek(word: string): string {
  const chars = [...word.normalize("NFD").toLowerCase()]
  const nextLetter = (from: number): string | undefined => chars.slice(from).find((c) => !isMark(c))
  let out = ""
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === ROUGH_BREATHING && out.length <= 1) {
      out = "h" + out
      continue
    }
    if (isMark(c)) continue
    if (c === "ο" && nextLetter(i + 1) === "υ") {
      // ου is one vowel, "u". Skip the υ and its marks.
      out += "u"
      i++
      while (i + 1 < chars.length && isMark(chars[i + 1])) i++
      continue
    }
    if (c === "γ" && /[γκχξ]/u.test(nextLetter(i + 1) ?? "")) {
      out += "n"
      continue
    }
    out += GREEK_LETTERS[c] ?? (/\p{L}/u.test(c) ? c : "")
  }
  return out
}

/** Fold a Latin spelling to the key two spellings of one name share. */
export function nameKey(spelling: string): string {
  return spelling
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/ch/g, "k")
    .replace(/th/g, "t")
    .replace(/c/g, "k")
    .replace(/[jy]/g, "i")
    .replace(/w/g, "u")
    .replace(/h/g, "")
    .replace(/(.)\1+/g, "$1")
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

const CASE_ENDING = /(os|ou|on|es|as|is|a|e|o|u|s)$/

/** How alike a Greek name (its lemma) and a word are, in [0, 1]. 0 for a word outside the Latin script. */
export function nameSimilarity(greekLemma: string, word: string): number {
  if (!/^\p{Script=Latin}+$/u.test(word.normalize("NFC").replace(/\p{M}/gu, ""))) return 0
  const greek = nameKey(transliterateGreek(greekLemma))
  const latin = nameKey(word)
  if (!greek || !latin) return 0
  const similarity = (x: string) => 1 - editDistance(x, latin) / Math.max(x.length, latin.length)
  const stem = greek.replace(CASE_ENDING, "")
  return Math.max(similarity(greek), stem.length >= 3 ? similarity(stem) : 0)
}

/** True when the word starts with a capital letter (Who's Who's names are capitalized in Latin script). */
export function isCapitalized(word: string): boolean {
  const first = word.charAt(0)
  return first !== first.toLowerCase() && first === first.toUpperCase()
}
