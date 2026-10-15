import { shortHash } from "../src/core/hash.ts"
import { plainOf } from "../src/core/tagged.ts"
import type { ContentUnit } from "../src/core/types.ts"

export const unit = (tagged: string, ordinal: number, opts: { scope?: string; id?: string; anchor?: string } = {}): ContentUnit => ({
  logicalId: opts.id ?? "",
  scope: opts.scope ?? "s",
  structuralPath: `p#${opts.scope ?? "s"}#${ordinal}`,
  ordinal,
  kind: "paragraph",
  tagged,
  plain: plainOf(tagged),
  contentHash: shortHash(tagged),
  ...(opts.anchor ? { nativeAnchor: opts.anchor } : {}),
})

export const units = (texts: readonly string[], ids?: readonly string[]): ContentUnit[] =>
  texts.map((t, i) => unit(t, i, ids ? { id: ids[i]! } : {}))

/**
 * Deterministic pseudo-random sentences. The vocabulary (~300 words) is far
 * smaller than real prose, so unrelated sentences overlap *more* than in real
 * documents — a deliberately harder setting for identity reconciliation.
 */
const SYL = ["ba", "ce", "di", "fo", "gu", "ha", "ke", "li", "mo", "nu", "pa", "re", "si", "to", "vu", "wa", "xe", "yo", "za", "lo"]
const WORDS: string[] = []
for (let i = 0; WORDS.length < 300; i++) WORDS.push(SYL[i % 20]! + SYL[(i * 7 + 3) % 20]! + (i % 3 === 0 ? SYL[(i * 13 + 5) % 20]! : ""))

export const sentence = (seed: number, len = 12): string => {
  // mulberry32: a proper PRNG, so different seeds give unrelated sentences.
  let a = (seed * 0x9e3779b1) >>> 0
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: string[] = []
  for (let i = 0; i < len; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]!)
  const s = out.join(" ")
  return `${s[0]!.toUpperCase()}${s.slice(1)} number ${seed}.`
}
