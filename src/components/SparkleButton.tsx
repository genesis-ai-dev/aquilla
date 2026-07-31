import { Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"

export function SparkleButton({ disabled, loading, onComplete, onDragStart, onDragEnter, tooltip, onSetupNeeded }: {
  disabled?: boolean; loading?: boolean; onComplete: () => void
  onDragStart?: () => void; onDragEnter?: () => void; tooltip?: string
  /** When provided and the button is disabled, clicking opens the AI setup modal instead. */
  onSetupNeeded?: () => void
}) {
  // If a setup handler is provided, the button intercepts disabled clicks — don't use native disabled.
  const nativeDisabled = disabled && !onSetupNeeded

  const button = (
    <button
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-colors",
        disabled
          ? onSetupNeeded
            ? "text-muted-foreground/30 hover:text-muted-foreground/50"
            : "cursor-not-allowed text-muted-foreground/30"
          : "text-muted-foreground hover:text-primary",
        loading && "animate-pulse text-primary"
      )}
      disabled={nativeDisabled}
      onClick={(e) => {
        e.stopPropagation()
        if (loading) return
        if (disabled && onSetupNeeded) { onSetupNeeded(); return }
        if (!disabled) onComplete()
      }}
      onMouseDown={(e) => { e.stopPropagation(); if (!disabled && !loading && onDragStart) onDragStart() }}
      onMouseEnter={() => { if (!disabled && !loading && onDragEnter) onDragEnter() }}
    >
      <Sparkles className="h-3 w-3" />
    </button>
  )

  if (!tooltip) return button

  return (
    <AppTooltip content={tooltip}>
      <span className="inline-flex">
        {button}
      </span>
    </AppTooltip>
  )
}
