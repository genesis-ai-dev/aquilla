import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import { OutboxInspectorPopover } from "./OutboxInspectorPopover"
import type { OutboxRecord } from "@/lib/sync/outbox"

interface OutboxSyncIndicatorProps {
  pendingCount: number
  failureStreak: number
  /** Pending records for the inspector popover. Inspector hidden when omitted. */
  records?: OutboxRecord[]
  className?: string
}

/**
 * Shows when CQRS audit events are waiting in IndexedDB or flusher retries are failing.
 * Clicking opens the OutboxInspectorPopover so users can see what's queued and why.
 */
export function OutboxSyncIndicator({
  pendingCount,
  failureStreak,
  records,
  className,
}: OutboxSyncIndicatorProps) {
  if (pendingCount === 0 && failureStreak < 3) return null
  const stuck = failureStreak >= 3
  const label = stuck ? "Sync backlog" : `Queued ${pendingCount}`
  const title = stuck
    ? "Could not sync audit events to the server. Edits are still saved locally."
    : `${pendingCount} change(s) queued for server sync`

  const trigger = (
    <ChipButton
      label={label}
      title={title}
      stuck={stuck}
      className={className}
    />
  )

  if (!records) return trigger

  return <OutboxInspectorPopover trigger={trigger} records={records} />
}

interface ChipProps {
  label: string
  title: string
  stuck: boolean
  className?: string
}

const ChipButton = forwardRef<HTMLButtonElement, ChipProps>(function ChipButton(
  { label, title, stuck, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      className={cn(
        "rounded-sm px-1.5 py-0.5 text-xs tabular-nums transition-colors",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        stuck ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
        className,
      )}
      {...rest}
    >
      {label}
    </button>
  )
})
