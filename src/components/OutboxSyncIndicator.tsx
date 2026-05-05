import { cn } from "@/lib/utils"

interface OutboxSyncIndicatorProps {
  pendingCount: number
  failureStreak: number
  className?: string
}

/**
 * Shows when CQRS audit events are waiting in IndexedDB or flusher retries are failing.
 */
export function OutboxSyncIndicator({
  pendingCount,
  failureStreak,
  className,
}: OutboxSyncIndicatorProps) {
  if (pendingCount === 0 && failureStreak < 3) return null
  const stuck = failureStreak >= 3
  const label = stuck ? "Sync backlog" : `Queued ${pendingCount}`
  const title = stuck
    ? "Could not sync audit events to the server. Edits are still saved locally."
    : `${pendingCount} change(s) queued for server sync`

  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        stuck ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
        className,
      )}
      title={title}
    >
      {label}
    </span>
  )
}
