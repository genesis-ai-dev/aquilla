import { forwardRef } from "react"
import { cn } from "@/lib/utils"
import { OutboxInspectorPopover } from "./OutboxInspectorPopover"
import type { OutboxRecord } from "@/lib/sync/outbox"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { useLeaderStalled } from "@/lib/offline/leader-watchdog"
import { useOfflineQueueCounts } from "@/lib/offline/queue-counts"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useConnectivity } from "@/lib/offline/connectivity"
import { useLastDownloadAt, useLastUploadAt } from "@/lib/offline/sync-times"
import { formatRelativeTime } from "@/lib/i18n/format"

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

export type ChipTone = "idle" | "queued" | "savedLocally" | "stuck" | "warning" | "notSaving"

/**
 * Pure. Most-urgent first. `savedLocally` is the honest offline state: edits
 * sit in this device's offline store and the backend is unreachable, so
 * "Queued" (which implies an upload in progress) would overstate things.
 * Only the offline store's rows count for it — IndexedDB outbox rows are not
 * durable across a restart the way LiveStore's are.
 */
export function deriveOutboxChipTone(s: {
  leaderStalled: boolean
  failed: number
  failureStreak: number
  pending: number
  offlinePending: number
  /** Backend reachability from the Tauri probe; null = unknown / web. */
  online: boolean | null
}): ChipTone {
  if (s.leaderStalled) return "notSaving"
  if (s.failed > 0) return "warning"
  if (s.online === false && s.offlinePending > 0) return "savedLocally"
  if (s.failureStreak >= 3) return "stuck"
  if (s.pending > 0) return "queued"
  return "idle"
}

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
  const { locale } = useI18n()
  const leaderStalled = useLeaderStalled()
  const { store: offlineStore } = useOfflineStore()
  const offline = useOfflineQueueCounts(offlineStore, projectId)
  const online = useConnectivity()
  const lastUpload = useLastUploadAt(projectId)
  const lastDownload = useLastDownloadAt(offlineStore, projectId)
  const pending = pendingCount + offline.pending
  const failed = failedCount + offline.failed
  const tone = deriveOutboxChipTone({
    leaderStalled,
    failed,
    failureStreak,
    pending,
    offlinePending: offline.pending,
    online,
  })

  const label =
    tone === "notSaving"
      ? t("editor.outbox.notSavingLabel")
      : tone === "warning"
        ? t("nav.outbox.failedCount", { count: failed })
        : tone === "savedLocally"
          ? t("editor.outbox.savedLocallyLabel", { count: pending })
          : tone === "stuck"
            ? t("editor.outbox.backlogLabel")
            : tone === "queued"
              ? t("editor.outbox.queuedLabel", { count: pending })
              : t("editor.outbox.syncedLabel")
  const baseTitle =
    tone === "notSaving"
      ? t("editor.outbox.notSavingTooltip")
      : tone === "warning"
        ? t("editor.outbox.failedTooltip", { count: failed })
        : tone === "savedLocally"
          ? t("editor.outbox.savedLocallyTooltip", { count: pending })
          : tone === "stuck"
            ? t("editor.outbox.backlogTooltip")
            : tone === "queued"
              ? t("editor.outbox.queuedTooltip", { count: pending })
              : t("editor.outbox.syncedTooltip")
  // Upload/download times only exist for a project downloaded for offline use.
  const never = t("editor.outbox.never")
  const title =
    lastDownload === null
      ? baseTitle
      : `${baseTitle} ${t("editor.outbox.syncTimes", {
          upload: lastUpload === null ? never : formatRelativeTime(lastUpload, locale),
          download: formatRelativeTime(lastDownload, locale),
        })}`

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
        (tone === "stuck" || tone === "savedLocally") && "text-amber-600 dark:text-amber-500",
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
