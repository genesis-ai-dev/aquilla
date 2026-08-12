// AQU-538 §3.2 — compact per-lane chips for an OrgHome project row.
//
// Each chip = lane tag (the '' lane shows the project's default target
// language, rendered first) + a mini translated-progress bar + the translated
// percentage. Visible chips are capped (default 3); the rest collapse into a
// "+N" affordance that expands the row's per-lane detail (when interactive).
//
// A single-lane project renders exactly one chip — visual parity with the
// old source→target column (no regression).

import { laneTranslatedPct, type PortfolioLane } from "@/lib/frontier/portfolio"
import { cn } from "@/lib/utils"
import { laneChipLabel, safePct } from "./project-lanes"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat, bidiIsolate } from "@/lib/i18n/format"

export interface LaneChipsProps {
  projectId: string
  /** Lanes in display order ('' default lane first). */
  lanes: PortfolioLane[]
  /** Label for the '' (default) lane — the project's target language. */
  defaultLaneLabel: string
  /** Max chips shown before collapsing into a "+N" overflow. */
  maxVisible?: number
  /** When set, the "+N" overflow becomes a button that expands the row. */
  onOverflowClick?: () => void
  className?: string
}

function LaneChip({
  projectId,
  lane,
  defaultLaneLabel,
}: {
  projectId: string
  lane: PortfolioLane
  defaultLaneLabel: string
}) {
  const t = useT()
  const { count } = useFormat()
  const pct = safePct(laneTranslatedPct(lane))
  const pctPlain = `${count(pct)}%`
  // Isolate only what is SEEN. The bidi isolates keep "40%" from reordering
  // beside RTL text, but they are invisible control characters: in an
  // accessible name they are noise a screen reader linearises away anyway, and
  // they leak into any assertion on that name.
  const pctDisplay = bidiIsolate(pctPlain)
  const label = laneChipLabel(lane.lane, defaultLaneLabel)
  const tooltip = t("org.laneChips.tooltip", { label, pct: pctDisplay })
  return (
    <AppTooltip content={tooltip}>
      <span
        data-testid={`lane-chip-${projectId}-${lane.lane}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded border bg-card px-1.5 py-0.5 text-xs"
        aria-label={t("org.laneChips.ariaLabel", { label, pct: pctPlain })}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{pctDisplay}</span>
      </span>
    </AppTooltip>
  )
}

export function LaneChips({
  projectId,
  lanes,
  defaultLaneLabel,
  maxVisible = 3,
  onOverflowClick,
  className,
}: LaneChipsProps) {
  if (lanes.length === 0) return null
  const visible = lanes.slice(0, maxVisible)
  const overflow = lanes.length - visible.length

  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-1", className)}>
      {visible.map((lane) => (
        <LaneChip
          key={lane.lane || "__default__"}
          projectId={projectId}
          lane={lane}
          defaultLaneLabel={defaultLaneLabel}
        />
      ))}
      {overflow > 0 &&
        (onOverflowClick ? (
          <button
            type="button"
            data-testid={`lane-chip-overflow-${projectId}`}
            className="inline-flex shrink-0 items-center rounded border bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation()
              onOverflowClick()
            }}
          >
            +{overflow}
          </button>
        ) : (
          <span
            data-testid={`lane-chip-overflow-${projectId}`}
            className="inline-flex shrink-0 items-center rounded border bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
          >
            +{overflow}
          </span>
        ))}
    </span>
  )
}
