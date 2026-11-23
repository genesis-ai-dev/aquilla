import type { HealthRibbonPoint } from "@/lib/health/health-ribbon"

/**
 * The compare `MemoizedRow` (EditorTable) bails out on — AQU-2654, decision
 * 0013 "a row's props are stable".
 *
 * `React.memo`'s shallow compare, except for the one row prop whose VALUE can
 * be unchanged under a new identity: the health ribbon re-smooths a
 * neighbourhood of rows when one of them changes and can hand each a new
 * point object carrying the numbers it already had. Every other prop is a
 * primitive, a per-cell value whose identity the cell store keeps, or a
 * callback the table keeps stable — and must stay that way: a prop that is a
 * fresh object, map or closure per table render fails this compare for every
 * row, which is the regression `editor-row-memo.test.ts` pins.
 */
export function memoizedRowPropsEqual<Props extends { healthRibbonPoint: HealthRibbonPoint }>(
  prev: Props,
  next: Props,
): boolean {
  const prevKeys = Object.keys(prev) as Array<keyof Props>
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) return false
    if (Object.is(prev[key], next[key])) continue
    if (key === "healthRibbonPoint" && healthRibbonPointsEqual(prev.healthRibbonPoint, next.healthRibbonPoint)) continue
    return false
  }
  return true
}

export function healthRibbonPointsEqual(a: HealthRibbonPoint, b: HealthRibbonPoint): boolean {
  return a.id === b.id
    && a.stage === b.stage
    && a.rawScore === b.rawScore
    && a.smoothedScore === b.smoothedScore
    && a.topScore === b.topScore
    && a.bottomScore === b.bottomScore
    && a.topOpacity === b.topOpacity
    && a.bottomOpacity === b.bottomOpacity
    && a.evidenceWeight === b.evidenceWeight
}
