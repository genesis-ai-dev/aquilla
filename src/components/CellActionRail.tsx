// Floating action rail for the cell row. Quiet by default — slides out from
// the row's right edge on hover/focus/tap-select with the same bouncy spring
// the codex-editor desktop sparkle popout uses.
//
// Visibility is driven by the parent (it already owns hover, focus, and
// "selected" state for the row). This file is intentionally just chrome:
// RailButton (one rail icon) + CellActionRail (the container with chevron).

import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"

// Bouncy spring matches the reference popout, slightly tamed for desktop.
// Original: cubic-bezier(.68,-0.75,.27,1.75)
const SPRING = "cubic-bezier(.68,-0.55,.32,1.45)"

interface RailButtonProps {
  icon: React.ReactNode
  tooltip: string
  onClick?: () => void
  disabled?: boolean
  /** Tiny notification dot on the button. Use sparingly. */
  dot?: "amber" | "emerald" | "red" | "primary"
  /** Indicates this button is in a transient busy state. */
  pulsing?: boolean
  /** Override the default muted tone (e.g. open-comments uses primary). */
  toneClass?: string
  onMouseDown?: (e: React.MouseEvent) => void
  onMouseEnter?: () => void
}

export function RailButton({
  icon, tooltip, onClick, disabled, dot, pulsing, toneClass,
  onMouseDown, onMouseEnter,
}: RailButtonProps) {
  const dotColor = dot === "amber"
    ? "bg-amber-500"
    : dot === "red"
      ? "bg-red-500"
      : dot === "primary"
        ? "bg-primary"
        : dot === "emerald"
          ? "bg-emerald-500"
          : null

  const button = (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (!disabled) onClick?.() }}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        disabled={disabled}
        aria-label={tooltip}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full",
          "transition-[transform,color,background-color] duration-150 ease-out",
          "active:scale-[0.88]",
          "hover:bg-muted/80",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          disabled
            ? "cursor-not-allowed text-muted-foreground/30"
            : toneClass ?? "text-muted-foreground/70 hover:text-foreground",
          pulsing && "animate-pulse",
        )}
      >
        {icon}
      </button>
      {dotColor && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-background",
            dotColor,
          )}
        />
      )}
    </div>
  )

  return <AppTooltip content={tooltip}>{button}</AppTooltip>
}

interface CellActionRailProps {
  /** Drives visibility of the spring-out portion of the rail. Parent computes
   *  this from row hover OR focus-within OR tap-selected. */
  revealed: boolean
  expanded: boolean
  onToggleExpanded: () => void
  /** Faint chevron persists when not revealed so the affordance is always
   *  discoverable even without hovering. */
  alwaysShowChevron?: boolean
  /** Tiny dot on the chevron — set when something inside the expansion needs
   *  attention (stale BT, transcript mismatch, unresolved infraction). */
  expansionAttentionDot?: "amber" | "red" | "emerald" | "primary" | null
  children: React.ReactNode
}

/**
 * Horizontal rail rendered at the row's right edge. The chevron is anchored;
 * the children spring/fade into view when `revealed` flips true.
 */
export function CellActionRail({
  revealed, expanded, onToggleExpanded,
  alwaysShowChevron, expansionAttentionDot, children,
}: CellActionRailProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-0.5 rounded-full px-1 py-0.5",
        // Soft raised pill only when revealed, so the rail lifts off the cell
        // surface as a neumorphic cluster instead of competing with text.
        revealed && "bg-card shadow-neu-sm",
      )}
      style={{ transition: "background-color 200ms ease-out, box-shadow 200ms ease-out" }}
    >
      <div
        className="flex items-center gap-0.5"
        style={{
          opacity: revealed ? 1 : 0,
          // Scale only — no translate. A translate moves the button's hit-box
          // during the reveal transition, which races mouse/Playwright clicks
          // (the click coord is computed pre-reveal and the button slides out
          // from underneath the cursor mid-transition).
          transform: revealed ? "scale(1)" : "scale(0.85)",
          transformOrigin: "right center",
          transition: `opacity 180ms ease-out, transform 220ms ${SPRING}`,
          pointerEvents: revealed ? "auto" : "none",
        }}
      >
        {children}
      </div>

      <div
        className={cn(
          "transition-opacity duration-150",
          revealed
            ? "opacity-100"
            : alwaysShowChevron
              ? "opacity-30 hover:opacity-100"
              : "pointer-events-none opacity-0",
        )}
      >
        <RailButton
          icon={
            <ChevronDown
              className="h-3.5 w-3.5"
              style={{
                transition: `transform 220ms ${SPRING}`,
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
          }
          tooltip={expanded ? "Close cell details" : "Open cell details"}
          onClick={onToggleExpanded}
          dot={expansionAttentionDot ?? undefined}
          toneClass={expanded
            ? "bg-card text-foreground shadow-neu-pressed"
            : "text-muted-foreground/70 hover:text-foreground"}
        />
      </div>
    </div>
  )
}

/** Returns true if the click target is something the user is meaningfully
 *  interacting with (button, link, input, contentEditable). Used to decide
 *  whether a click on the row should toggle "selected" or pass through. */
export function isInteractiveTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return Boolean(
    el.closest(
      "button, a, input, textarea, [contenteditable=true], [role='button'], [role='tab']",
    ),
  )
}
