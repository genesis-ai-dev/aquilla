/**
 * UsageRingIcon — the 16px progress ring shared by the agent usage gauges
 * (CreditsDial for maintainers, the run-budget ring for everyone else).
 */

/** Ring color mirrors the cap-pressure convention used elsewhere. */
function ringClass(pct: number): string {
  if (pct >= 85) return "stroke-red-500"
  if (pct >= 60) return "stroke-amber-500"
  return "stroke-sky-500"
}

export function UsageRingIcon({ pct }: { pct: number }) {
  // Ring drawn in a 12x12 box, rendered at 16px. The radius insets by half the
  // stroke so the arc stays inside the box at this weight.
  const stroke = 2.5
  const r = (12 - stroke) / 2
  const C = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 12 12" className="size-4 -rotate-90" aria-hidden>
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth={stroke} className="stroke-muted-foreground/25" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * C} ${C}`}
        className={ringClass(pct)}
      />
    </svg>
  )
}
