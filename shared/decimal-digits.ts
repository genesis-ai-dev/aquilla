// Every script's decimal digits, read as 0–9.
//
// JS `\d` is ASCII only, and NFKC folds fullwidth and mathematical digits but
// leaves a script's own digits alone: Arabic-Indic ٥, Persian ۵, Devanagari ५,
// Bengali ৫, Burmese ၅, Thai ๕ and the rest stay as they are. A digit here is
// any Unicode decimal digit (General_Category Nd), so there is no per-script
// list to keep up.
//
// Shared by bulk audio upload's name reader (AQU-2329) and the "number from
// source missing" check (AQU-1667), so the two read numbers the same way.

const IS_DIGIT = /^\p{Nd}$/u
const ANY_DIGIT = /\p{Nd}/gu

/**
 * A decimal digit's value, 0–9, in any script.
 *
 * Unicode's stability policy keeps every script's decimal digits in one run of
 * ten consecutive code points, 0 first. Some runs sit back to back (the five
 * mathematical digit styles fill U+1D7CE–1D7FF), so the value is the distance
 * from the start of the run, mod 10. Runs are at most 50 long, and each code
 * point is worked out once.
 */
const digitValues = new Map<number, number>()
export function decimalDigitValue(cp: number): number {
  const known = digitValues.get(cp)
  if (known !== undefined) return known
  let start = cp
  while (start > 0 && IS_DIGIT.test(String.fromCodePoint(start - 1))) start--
  const value = (cp - start) % 10
  digitValues.set(cp, value)
  return value
}

/** "متى ٥_١" → "متى 5_1": every decimal digit becomes its 0–9 digit; nothing else changes. */
export function toWesternDigits(text: string): string {
  return text.replace(ANY_DIGIT, (ch) => String(decimalDigitValue(ch.codePointAt(0)!)))
}
