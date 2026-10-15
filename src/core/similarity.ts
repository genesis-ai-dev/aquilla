/**
 * Cheap, script-agnostic text similarity used by identity reconciliation.
 * Blends word-level and character-trigram Dice coefficients so it behaves for
 * space-delimited scripts, CJK, and very short strings alike.
 */
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

const trigrams = (s: string): string[] => {
  const t = ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `
  if (t.length < 3) return [t]
  const out: string[] = []
  for (let i = 0; i + 3 <= t.length; i++) out.push(t.slice(i, i + 3))
  return out
}

const dice = (a: string[], b: string[]): number => {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1)
  let common = 0
  for (const y of b) {
    const c = counts.get(y) ?? 0
    if (c > 0) {
      common++
      counts.set(y, c - 1)
    }
  }
  return (2 * common) / (a.length + b.length)
}

export const similarity = (a: string, b: string): number => {
  if (a === b) return 1
  const wa = words(a)
  const wb = words(b)
  const tri = dice(trigrams(a), trigrams(b))
  if (wa.length < 3 || wb.length < 3) return tri
  return 0.5 * dice(wa, wb) + 0.5 * tri
}

/**
 * Share of `part`'s trigrams that also occur in `whole` — high when `part` is
 * a fragment of `whole` (used to recognise splits and merges).
 */
export const containment = (part: string, whole: string): number => {
  const p = trigrams(part)
  if (p.length === 0) return 0
  const counts = new Map<string, number>()
  for (const x of trigrams(whole)) counts.set(x, (counts.get(x) ?? 0) + 1)
  let hit = 0
  for (const x of p) {
    const c = counts.get(x) ?? 0
    if (c > 0) {
      hit++
      counts.set(x, c - 1)
    }
  }
  return hit / p.length
}
