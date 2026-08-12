import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export type SyncStatus = "live" | "connecting" | "offline" | "idle" | "disabled"

interface SyncStatusIndicatorProps {
  status: SyncStatus
  className?: string
}

/**
 * A tiny dot + label indicating whether the file is syncing to the sync-worker.
 * Dot colors:
 *   live       — green  → WS connected AND initial sync complete
 *   connecting — amber  → WS not yet established, or handshake in progress
 *   offline    — red    → was connected and now isn't (reconnect backoff)
 *   idle       — grey   → intentionally disconnected while the tab is hidden,
 *                         will resume when the user returns
 *   disabled   — grey   → no session, no project/file selected, or sync turned off
 */
export function SyncStatusIndicator({ status, className }: SyncStatusIndicatorProps) {
  const t = useT()
  const { dot, labelKey, tooltipKey } = describeStatus(status)
  const label = t(labelKey)
  const tooltip = t(tooltipKey)
  return (
    <AppTooltip content={tooltip}>
      <span
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground",
          className,
        )}
        aria-label={tooltip}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            dot,
            status === "connecting" && "animate-pulse"
          )}
        />
        <span className="leading-none">{label}</span>
      </span>
    </AppTooltip>
  )
}

/** Pure — no hook access, so it returns message keys rather than text; the
 *  component above resolves them with `useT()`. */
function describeStatus(status: SyncStatus): {
  dot: string
  labelKey: MessageKey
  tooltipKey: MessageKey
} {
  switch (status) {
    case "live":
      return {
        dot: "bg-green-500",
        labelKey: "editor.sync.live",
        tooltipKey: "editor.sync.liveTooltip",
      }
    case "connecting":
      return {
        dot: "bg-amber-500",
        labelKey: "editor.sync.connecting",
        tooltipKey: "editor.sync.connectingTooltip",
      }
    case "offline":
      return {
        dot: "bg-red-500",
        labelKey: "editor.sync.offline",
        tooltipKey: "editor.sync.offlineTooltip",
      }
    case "idle":
      return {
        dot: "bg-muted-foreground/40",
        labelKey: "editor.sync.paused",
        tooltipKey: "editor.sync.pausedTooltip",
      }
    case "disabled":
      return {
        dot: "bg-muted-foreground/40",
        labelKey: "editor.sync.noFileOpen",
        tooltipKey: "editor.sync.noFileOpenTooltip",
      }
  }
}
