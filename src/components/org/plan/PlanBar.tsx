// AQU-1092…1098: one lane of progress as a NESTED bar.
//
// Two figures ride in a single track: the outer measure (translated, recorded)
// and the inner one it contains (validated). Validated is a subset of
// translated, so drawing it inside says so — two separate tracks would let a
// reader believe the numbers add up, which they never do. It is also the shape
// the app's existing rollup bar already uses, so four numbers cost the width of
// two and the eye reads a bar faster than a digit.
//
// The hues are the design's own oklch values rather than palette approximations
// because the containment only reads when the inner fill is a deliberate step
// from the outer one. Text is the app's --primary over a deeper blue; audio is
// a quieter teal, far enough from the text hue that a row with both never reads
// as one four-part bar.

export type PlanBarTone = "text" | "audio"

const TONE: Record<PlanBarTone, { outer: string; inner: string }> = {
  text: {
    outer: "bg-primary",
    inner: "bg-[oklch(0.52_0.11_245)] dark:bg-[oklch(0.82_0.09_245)]",
  },
  audio: {
    outer: "bg-[oklch(0.74_0.09_200)] dark:bg-[oklch(0.72_0.09_200)]",
    inner: "bg-[oklch(0.52_0.11_200)] dark:bg-[oklch(0.84_0.08_200)]",
  },
}

export function PlanBar({ label, outer, inner, tone, aria }: {
  /** Omitted where the caller supplies its own leading gutter (a chapter number). */
  label?: string
  /** Percentage 0–100 of the containing measure. */
  outer: number
  /** Percentage 0–100 of the contained one; drawn over the outer fill. */
  inner: number
  tone: PlanBarTone
  aria: string
}) {
  const hue = TONE[tone]
  return (
    <span className="flex items-center gap-2" aria-label={aria}>
      {label != null && (
        <span className="w-6 shrink-0 text-[9.5px] font-semibold tracking-wider text-muted-foreground">
          {label}
        </span>
      )}
      <span className="relative h-1 min-w-[52px] flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={`absolute inset-y-0 start-0 rounded-full ${hue.outer}`}
          style={{ width: `${outer}%` }}
        />
        <span
          className={`absolute inset-y-0 start-0 rounded-full ${hue.inner}`}
          style={{ width: `${inner}%` }}
        />
      </span>
      <span className="w-[60px] shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {outer}
        <span className="px-px opacity-40">/</span>
        {inner}%
      </span>
    </span>
  )
}
