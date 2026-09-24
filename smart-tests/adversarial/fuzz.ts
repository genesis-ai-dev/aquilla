/** Deterministic goal-wording variants. No model writes these. */

/** mulberry32: small, seeded, reproducible from the evidence alone. */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Numeric seed for one test, derived from the run id and the test's identity. */
export function seedFor(...parts: string[]): number {
  let hash = 2166136261
  for (const char of parts.join("|")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

/**
 * Swap two adjacent, different inner letters in one word of four or more
 * letters. Identical pairs ("ee" in "Keep") are skipped: swapping them would
 * leave the goal unchanged and the variant would silently test nothing.
 */
export function typo(text: string, seed: number): string {
  const words = text.split(" ")
  const swaps = words.flatMap((word, index) => /^[A-Za-z]{4,}$/.test(word)
    ? Array.from({ length: word.length - 3 }, (_, i) => i + 1)
      .filter((at) => word[at] !== word[at + 1]).map((at) => ({ index, at }))
    : [])
  if (swaps.length === 0) return text
  const { index, at } = swaps[Math.floor(rng(seed)() * swaps.length)]
  const word = words[index]
  words[index] = word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2)
  return words.join(" ")
}

/** Remove the quotation marks around one name, leaving the words in place. */
export function unquote(goal: string, name: string): string {
  return goal.replace(`"${name}"`, name)
}
