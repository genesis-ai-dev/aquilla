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

type ChipTone = "idle" | "queued" | "stuck"

/**
 * Renders the outbox status chip in the workspace status bar. Always visible
 * so users can open the inspector even when the queue is empty (peace of mind:
 * "is anything stuck?"). Tone shifts as the queue fills up or retries fail.
 */
export function OutboxSyncIndicator({
  pendingCount,
  failureStreak,
  records,
  className,
}: OutboxSyncIndicatorProps) {
  const stuck = failureStreak >= 3
  const tone: ChipTone = stuck ? "stuck" : pendingCount > 0 ? "queued" : "idle"

  const label =
    tone === "stuck"
      ? "Sync backlog"
      : tone === "queued"
        ? `Queued ${pendingCount}`
        : "Synced"
  const title =
    tone === "stuck"
      ? "Could not sync audit events to the server. Edits are still saved locally. Click to inspect."
      : tone === "queued"
        ? `${pendingCount} change(s) queued for server sync. Click to inspect.`
        : "All audit events synced. Click to inspect the queue."

  const trigger = <ChipButton label={label} title={title} tone={tone} className={className} />

  if (!records) return trigger

  return <OutboxInspectorPopover trigger={trigger} records={records} />
}

interface ChipProps {
  label: string
  title: string
  tone: ChipTone
  className?: string
}

const ChipButton = forwardRef<HTMLButtonElement, ChipProps>(function ChipButton(
  { label, title, tone, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      className={cn(
        "rounded-full px-2 py-0.5 text-xs tabular-nums transition-all",
        "hover:bg-card hover:shadow-neu-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "stuck" && "text-amber-600 dark:text-amber-500",
        tone === "queued" && "text-foreground",
        tone === "idle" && "text-muted-foreground/70",
        className,
      )}
      {...rest}
    >
      {label}
    </button>
  )
})
