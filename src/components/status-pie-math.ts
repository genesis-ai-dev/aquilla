/** Linear workflow-state icon geometry (14×14 viewBox, inner r=2). */

export const STATUS_PIE_VIEWBOX = 14
export const STATUS_PIE_CENTER = 7
export const STATUS_PIE_OUTER_R = 6
export const STATUS_PIE_INNER_R = 2
export const STATUS_PIE_OUTER_STROKE = 1.5
export const STATUS_PIE_INNER_STROKE = 4

/** Linear “done” workflow icon — full inner disc at r=3. */
export const STATUS_PIE_COMPLETE_INNER_R = 3
export const STATUS_PIE_COMPLETE_INNER_STROKE = 6
export const STATUS_PIE_COMPLETE_INNER_C = 2 * Math.PI * STATUS_PIE_COMPLETE_INNER_R

/** Matches former CheckCheck validation icon: text-green-600 / dark:text-green-500. */
export const STATUS_PIE_COMPLETE_STROKE = "var(--color-green-600)"
export const STATUS_PIE_COMPLETE_BACKGROUND =
  "color-mix(in oklch, var(--color-green-600) 25%, transparent)"

/** Linear-style workflow palette. */
export const STATUS_PIE_IDLE = "#BEC2C8"
export const STATUS_PIE_OTHERS = "#95A2B3"
export const STATUS_PIE_PARTIAL = "#F2C94C"
/** Linear cyan — used at ~¾ (75%) quorum progress. */
export const STATUS_PIE_CYAN = "#5DB1C9"

const INNER_C = 2 * Math.PI * STATUS_PIE_INNER_R
/** Matches Linear's inner dash length (~97% of circumference). */
const INNER_DASH_LEN = INNER_C * 0.97

/**
 * Pie wedge via thick stroke on the inner circle (rotate -90° at center).
 * `progress` 0 → hidden wedge; 1 → full ring.
 */
export function statusPieInnerStroke(progress: number): {
  strokeDasharray: string
  strokeDashoffset: number
} {
  const p = Math.min(1, Math.max(0, progress))
  return {
    strokeDasharray: `${INNER_DASH_LEN} ${INNER_C * 2}`,
    strokeDashoffset: INNER_C * (1 - p),
  }
}

const WEDGE_RAD = (deg: number) => ((deg - 90) * Math.PI) / 180

/** Solid pie slice from center (0° = 12 o'clock, clockwise). */
export function statusPieWedgePath(
  cx: number,
  cy: number,
  radius: number,
  progress: number,
): string {
  const sweep = Math.min(360, Math.max(0, progress) * 360)
  if (sweep <= 0) return ""
  if (sweep >= 359.9) {
    return `M ${cx - radius} ${cy} A ${radius} ${radius} 0 1 0 ${cx + radius} ${cy} A ${radius} ${radius} 0 1 0 ${cx - radius} ${cy} Z`
  }
  const start = WEDGE_RAD(0)
  const end = WEDGE_RAD(sweep)
  const x1 = cx + radius * Math.cos(start)
  const y1 = cy + radius * Math.sin(start)
  const x2 = cx + radius * Math.cos(end)
  const y2 = cy + radius * Math.sin(end)
  const large = sweep > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`
}

export const STATUS_PIE_WEDGE_RADIUS = 4
