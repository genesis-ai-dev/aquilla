/** Score mixing shared by suggestions and the thesaurus. */

export type Ranked = Array<[string, number]>

export type SourceMix = "add" | "boost"

/** In "boost" mixing, how much a source-only word scores relative to alpha*src. */
export const BOOST_FLOOR = 0.25

/** Max-normalise both score sets and add alpha x the second to the first. */
export function mixScores(
  primary: Ranked,
  secondary: ReadonlyMap<string, number>,
  alpha: number,
  mode: SourceMix = "add",
): Map<string, number> {
  const topPrimary = primary[0]?.[1] ?? 0
  let topSecondary = 0
  for (const v of secondary.values()) if (v > topSecondary) topSecondary = v
  const out = new Map<string, number>()
  for (const [w, v] of primary) out.set(w, topPrimary > 0 ? v / topPrimary : 0)
  if (topSecondary === 0) return out
  for (const [w, v] of secondary) {
    const s = (alpha * v) / topSecondary
    const b = out.get(w) ?? 0
    out.set(w, mode === "boost" ? b * (1 + s) + BOOST_FLOOR * s : b + s)
  }
  return out
}
