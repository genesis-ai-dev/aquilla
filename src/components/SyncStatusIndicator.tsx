import { cn } from "@/lib/utils"

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
  const { dot, label, tooltip } = describeStatus(status)
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", className)}
      title={tooltip}
      aria-label={tooltip}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          dot,
          status === "connecting" && "animate-pulse"
        )}
      />
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function describeStatus(status: SyncStatus): { dot: string; label: string; tooltip: string } {
  switch (status) {
    case "live":
      return {
        dot: "bg-green-500",
        label: "Live",
        tooltip: "Live — changes are syncing to Cloudflare and across devices",
      }
    case "connecting":
      return {
        dot: "bg-amber-500",
        label: "Connecting",
        tooltip: "Connecting to the sync server…",
      }
    case "offline":
      return {
        dot: "bg-red-500",
        label: "Offline",
        tooltip: "Offline — changes are saved locally and will sync when reconnected",
      }
    case "idle":
      return {
        dot: "bg-muted-foreground/40",
        label: "Paused",
        tooltip: "Sync paused while the tab is hidden — will resume when you return",
      }
    case "disabled":
      return {
        dot: "bg-muted-foreground/40",
        label: "Local only",
        tooltip: "Sync disabled — changes are saved locally only",
      }
  }
}
