/**
 * Cheap, script-agnostic text similarity used by identity reconciliation.
 * Blends word-level and character-trigram Dice coefficients so it behaves for
 * space-delimited scripts, CJK, and very short strings alike.
 *
 * Features are memoised per string and encoded as sorted integer arrays
 * (token ids from a shared dictionary), so comparing two paragraphs is a
 * linear merge over typed arrays. Reconciliation compares the same paragraphs
 * many times; this keeps a fully rewritten 400-paragraph chapter well under a
 * second.
 */
interface Features {
  readonly words: Int32Array
  readonly tri: Int32Array
}

const ids = new Map<string, number>()
const idOf = (token: string): number => {
  let id = ids.get(token)
  if (id === undefined) {
    id = ids.size
    ids.set(token, id)
  }
  return id
}

const cache = new Map<string, Features>()
const MAX_CACHE = 50_000

const encode = (tokens: readonly string[]): Int32Array => {
  const out = new Int32Array(tokens.length)
  for (let i = 0; i < tokens.length; i++) out[i] = idOf(tokens[i]!)
  return out.sort()
}

const features = (s: string): Features => {
  let f = cache.get(s)
  if (f) return f
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const t = ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `
  const tris: string[] = []
  if (t.length < 3) tris.push(t)
  else for (let i = 0; i + 3 <= t.length; i++) tris.push(t.slice(i, i + 3))
  f = { words: encode(words), tri: encode(tris) }
  if (cache.size >= MAX_CACHE) {
    cache.clear()
    if (ids.size > 2_000_000) ids.clear()
  }
  cache.set(s, f)
  return f
}

/** Size of the multiset intersection of two sorted arrays. */
const common = (a: Int32Array, b: Int32Array): number => {
  let i = 0
  let j = 0
  let n = 0
  while (i < a.length && j < b.length) {
    const x = a[i]!
    const y = b[j]!
    if (x === y) {
      n++
      i++
      j++
    } else if (x < y) i++
    else j++
  }
  return n
}

const dice = (a: Int32Array, b: Int32Array): number => {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  return (2 * common(a, b)) / (a.length + b.length)
}

export const similarity = (a: string, b: string): number => {
  if (a === b) return 1
  const fa = features(a)
  const fb = features(b)
  const tri = dice(fa.tri, fb.tri)
  if (fa.words.length < 3 || fb.words.length < 3) return tri
  return 0.5 * dice(fa.words, fb.words) + 0.5 * tri
}

/**
 * Share of `part`'s trigrams that also occur in `whole` — high when `part` is
 * a fragment of `whole` (used to recognise splits and merges).
 */
export const containment = (part: string, whole: string): number => {
  const p = features(part)
  if (p.tri.length === 0) return 0
  return common(p.tri, features(whole).tri) / p.tri.length
}
