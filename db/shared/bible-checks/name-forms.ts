// The Latin-letter key of a Greek or Hebrew name form (AQU-1699, P4).
//
// A name-form decision is a project fact, and a fact key is dot-separated
// words of ASCII letters, digits, "-" and "_" (../project-facts.ts). So the
// form Κηφᾶς is keyed "kephas": the lemma without accents, letter by letter in
// Latin, with a rough breathing as a leading "h" (Ἡρῴδης → "herodes"). Hebrew
// keeps its consonants (שָׁאוּל → "shvl"): the key names the form, it is not a
// pronunciation.
//
// Relative imports only, no DOM: shared with the workers.

const GREEK: Readonly<Record<string, string>> = {
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'e', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'ph', χ: 'ch', ψ: 'ps', ω: 'o',
}

const HEBREW: Readonly<Record<string, string>> = {
  א: '', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'ch', ט: 't', י: 'y', כ: 'k', ך: 'k', ל: 'l',
  מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's', ע: '', פ: 'p', ף: 'p', צ: 'ts', ץ: 'ts', ק: 'q', ר: 'r', ש: 'sh', ת: 't',
}

const ROUGH_BREATHING = '̔'
/** υ after these vowels is the second half of a diphthong: αυ, ευ, ηυ, ου. */
const DIPHTHONG_FIRST = new Set(['α', 'ε', 'η', 'ο'])
/** γ before these is a nasal: ἄγγελος → "angelos". */
const NASAL_BEFORE = new Set(['γ', 'κ', 'ξ', 'χ'])

/**
 * The key for a name form, or null when nothing in it has a Latin letter.
 * Exported for the decision-key help and the eval; P4 compares keys only.
 */
export function nameFormKey(lemma: string): string | null {
  const letters = Array.from(lemma.normalize('NFD').toLowerCase())
  let out = ''
  let rough = false
  let previous = ''
  let seen = 0
  letters.forEach((ch, i) => {
    if (ch === ROUGH_BREATHING) {
      // A breathing sits on the first vowel or diphthong of the word.
      if (seen <= 2) rough = true
      return
    }
    if (/\p{M}/u.test(ch)) return
    const next = letters.slice(i + 1).find((c) => !/\p{M}/u.test(c)) ?? ''
    let latin: string | undefined
    if (ch === 'υ' && DIPHTHONG_FIRST.has(previous)) latin = 'u'
    else if (ch === 'γ' && NASAL_BEFORE.has(next)) latin = 'n'
    else latin = GREEK[ch] ?? HEBREW[ch] ?? (/[a-z0-9]/.test(ch) ? ch : undefined)
    if (latin === undefined) return
    out += latin
    previous = ch
    seen++
  })
  if (rough) out = out.startsWith('r') ? `rh${out.slice(1)}` : `h${out}`
  return /^[a-z0-9]+$/.test(out) ? out : null
}
