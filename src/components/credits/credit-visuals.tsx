// Shared visual primitives for the two credit surfaces (org CreditsPanel +
// platform AdminCreditsSection). Keeping the rail palette and bar rendering in
// one place means "Agent is amber, Chat is sky, TTS is violet" reads the same
// on both screens, and the per-rail breakdown the API already returns
// (byRail: { agent, llm, tts }) is surfaced consistently.

import { formatCredits } from "@/lib/credits"
import { type Rail, RAIL_META, RAIL_ORDER } from "./rails"

/**
 * One bar that does double duty: total fill = spend/cap (how full), and the
 * fill is split into per-rail segments (what it's made of). The unused
 * remainder is the muted track. Segments over 100% are clipped by
 * overflow-hidden so an over-cap window still reads as "full", not broken.
 */
export function SegmentedCapBar({
  byRail,
  cap,
  className = "h-2",
}: {
  byRail: Record<string, number>
  cap: number
  className?: string
}) {
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-muted ${className}`}>
      {RAIL_ORDER.map((rail) => {
        const v = byRail[rail] ?? 0
        const w = cap > 0 ? Math.min(100, (v / cap) * 100) : 0
        if (w <= 0) return null
        return (
          <div
            key={rail}
            className={RAIL_META[rail].seg}
            style={{ width: `${w}%` }}
            aria-hidden
          />
        )
      })}
    </div>
  )
}

/**
 * Compact legend: one chip per rail (colored dot · label · value). `chipTestId`
 * lets a caller stamp a stable test id on a given rail's chip — the org panel
 * scopes by window (`rail-day-agent`), the admin table scopes by org
 * (`agent-day-1`) so the FRO-414 anti-transposition tests can pin each value.
 */
export function RailLegend({
  byRail,
  chipTestId,
}: {
  byRail: Record<string, number>
  chipTestId?: (rail: Rail) => string | undefined
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {RAIL_ORDER.map((rail) => (
        <span
          key={rail}
          data-testid={chipTestId?.(rail)}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${RAIL_META[rail].dot}`} />
          {RAIL_META[rail].label}
          <span className="font-medium tabular-nums text-foreground">
            {formatCredits(byRail[rail] ?? 0)}
          </span>
        </span>
      ))}
    </div>
  )
}
