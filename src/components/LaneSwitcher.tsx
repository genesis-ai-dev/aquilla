// AQU-538 (slice 2): the active-target-lane switcher.
//
// Data model (docs/superpowers/specs/2026-07-11-project-data-model-decision.md):
// one source, N target lanes; `''` is the default lane. This control lets the
// translator pick which target lane the editor reads and writes. It renders a
// compact segmented button group — options are always in the DOM (unlike a
// portalled Select), which keeps it testable and avoids the Base-UI
// "SelectItem value can't be ''" limitation for the default lane.
//
// N=1 back-compat: with only the default lane available (`lanes.length <= 1`)
// the switcher renders nothing at all, so a single-lane project's header is
// byte-identical to before.

import { cn } from "@/lib/utils"

export interface LaneSwitcherProps {
  /**
   * Available lanes, default lane FIRST as `''`. Callers build this as
   * `['', ...targetLanes]`. When `length <= 1` the control renders `null`.
   */
  lanes: string[]
  /** The active lane (`''` = default). */
  value: string
  /** Called with the chosen lane (`''` for the default). */
  onChange: (lane: string) => void
  /**
   * Human label for the default (`''`) lane — the project/file's
   * `targetLanguage` name. Non-default lanes render their own tag string.
   */
  defaultLaneLabel: string
  className?: string
}

/** Stable per-option testid: default lane is the empty tag `lane-option-`. */
function laneOptionTestId(lane: string): string {
  return `lane-option-${lane}`
}

export function LaneSwitcher({
  lanes,
  value,
  onChange,
  defaultLaneLabel,
  className,
}: LaneSwitcherProps) {
  // N=1: no non-default lanes → the switcher is invisible.
  if (lanes.length <= 1) return null

  return (
    <div
      data-testid="lane-switcher"
      role="radiogroup"
      aria-label="Active translation lane"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5",
        className,
      )}
    >
      {lanes.map((lane) => {
        const active = lane === value
        const label = lane === "" ? defaultLaneLabel : lane
        return (
          <button
            key={lane || "__default__"}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={laneOptionTestId(lane)}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(lane)}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
