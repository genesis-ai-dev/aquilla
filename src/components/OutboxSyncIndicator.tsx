import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import { OutboxInspectorPopover } from "./OutboxInspectorPopover"
import type { OutboxRecord } from "@/lib/sync/outbox"
import { useT } from "@/lib/i18n/I18nProvider"
import { useLeaderStalled } from "@/lib/offline/leader-watchdog"
import { useOfflineQueueCounts } from "@/lib/offline/queue-counts"
import { useOfflineStore } from "@/context/OfflineStoreContext"

interface OutboxSyncIndicatorProps {
  pendingCount: number
  failureStreak: number
  /** Count of records that permanently failed (exceeded retry cap). */
  failedCount?: number
  /** Pending records for the inspector popover. Inspector hidden when omitted. */
  records?: OutboxRecord[]
  /** Reset backoff + force an immediate flush. Wired to the inspector's
   *  "Retry now" button. */
  onRetryNow?: () => void
  /** Tauri: also counts this project's offline queue (src/lib/offline/queue-counts.ts). */
  projectId?: string | null
  className?: string
}

type ChipTone = "idle" | "queued" | "stuck" | "warning" | "notSaving"

/**
 * Renders the outbox status chip in the workspace status bar. Always visible
 * so users can open the inspector even when the queue is empty (peace of mind:
 * "is anything stuck?"). Tone shifts as the queue fills up or retries fail.
 * A stalled offline-store leader (Tauri) outranks every outbox state: they all
 * assume local saving works, so none of them may show while it doesn't.
 * In Tauri, edits on an offline-ready project queue in the offline store
 * rather than the outbox, so its pending and refused rows count too.
 */
export function OutboxSyncIndicator({
  pendingCount,
  failureStreak,
  failedCount = 0,
  records,
  onRetryNow,
  projectId,
  className,
}: OutboxSyncIndicatorProps) {
  const t = useT()
  const leaderStalled = useLeaderStalled()
  const { store: offlineStore } = useOfflineStore()
  const offline = useOfflineQueueCounts(offlineStore, projectId)
  const pending = pendingCount + offline.pending
  const failed = failedCount + offline.failed
  const stuck = failureStreak >= 3
  const hasFailed = failed > 0
  const tone: ChipTone = leaderStalled
    ? "notSaving"
    : hasFailed
      ? "warning"
      : stuck
        ? "stuck"
        : pending > 0
          ? "queued"
          : "idle"

  const label =
    tone === "notSaving"
      ? t("editor.outbox.notSavingLabel")
      : tone === "warning"
        ? t("nav.outbox.failedCount", { count: failed })
        : tone === "stuck"
          ? t("editor.outbox.backlogLabel")
          : tone === "queued"
            ? t("editor.outbox.queuedLabel", { count: pending })
            : t("editor.outbox.syncedLabel")
  const title =
    tone === "notSaving"
      ? t("editor.outbox.notSavingTooltip")
      : tone === "warning"
        ? t("editor.outbox.failedTooltip", { count: failed })
        : tone === "stuck"
          ? t("editor.outbox.backlogTooltip")
          : tone === "queued"
            ? t("editor.outbox.queuedTooltip", { count: pending })
            : t("editor.outbox.syncedTooltip")

  const trigger = <ChipButton label={label} title={title} tone={tone} className={className} />

  if (!records) return trigger

  return (
    <OutboxInspectorPopover
      trigger={trigger}
      records={records}
      pendingCount={pendingCount}
      onRetryNow={onRetryNow}
    />
  )
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
      aria-label={title}
      className={cn(
        "inline-flex h-7 items-center rounded-md border border-border/70 bg-background/80 px-2 text-xs tabular-nums shadow-sm",
        "hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        (tone === "warning" || tone === "notSaving") && "text-destructive",
        tone === "notSaving" && "border-destructive/60",
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
