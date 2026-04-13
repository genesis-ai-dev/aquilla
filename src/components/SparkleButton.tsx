import { Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

export function SparkleButton({ disabled, loading, onComplete, onDragStart, onDragEnter, tooltip }: {
  disabled?: boolean; loading?: boolean; onComplete: () => void
  onDragStart?: () => void; onDragEnter?: () => void; tooltip?: string
}) {
  return (
    <button
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded transition-colors",
        disabled ? "cursor-not-allowed text-muted-foreground/30" : "cursor-pointer text-muted-foreground hover:text-primary",
        loading && "animate-pulse text-primary"
      )}
      disabled={disabled}
      title={tooltip}
      onClick={(e) => { e.stopPropagation(); if (!disabled && !loading) onComplete() }}
      onMouseDown={(e) => { e.stopPropagation(); if (!disabled && !loading && onDragStart) onDragStart() }}
      onMouseEnter={() => { if (!disabled && !loading && onDragEnter) onDragEnter() }}
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  )
}
