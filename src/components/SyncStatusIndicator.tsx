import { useState } from "react"
import { ArrowDown, ArrowUp, Clock3 } from "lucide-react"
import { useConnectionActivity } from "@/hooks/useConnectionActivity"
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export type SyncStatus =
  | "live"
  | "syncing"
  | "retrying"
  | "reconnecting"
  | "connecting"
  | "offline"
  | "idle"
  | "disabled"

interface SyncStatusIndicatorProps {
  status: SyncStatus
  className?: string
}

/**
 * A tiny dot + label indicating whether the file is syncing to the sync-worker.
 * Dot colors:
 *   live         — green  → online, WS open, outbox empty (nothing unsaved)
 *   syncing      — amber  → outbox has queued writes, no failed attempt yet
 *   retrying     — red    → outbox has queued writes and a drain has failed
 *   reconnecting — amber  → online but the project WS is not open
 *   connecting   — amber  → WS not yet established, or handshake in progress
 *   offline      — red    → navigator.onLine is false
 *   idle       — grey   → intentionally disconnected while the tab is hidden,
 *                         will resume when the user returns
 *   disabled   — grey   → no session, no project/file selected, or sync turned off
 */
export function SyncStatusIndicator({ status, className }: SyncStatusIndicatorProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const activity = useConnectionActivity(open)
  const connected = status === "live" || status === "syncing" || status === "retrying"
  const formatRate = (bytes: number) => {
    if (!connected) return "—"
    if (bytes === 0) return t("editor.sync.noActivity")
    const unit = bytes >= 1_000_000 ? "MB/s" : bytes >= 1_000 ? "kB/s" : "B/s"
    const value = bytes >= 1_000_000 ? bytes / 1_000_000 : bytes >= 1_000 ? bytes / 1_000 : bytes
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`
  }
  const { dot, labelKey, tooltipKey } = describeStatus(status)
  const label = t(labelKey)
  const tooltip = t(tooltipKey)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip content={tooltip} disabled={open}>
        <PopoverTrigger
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2 text-xs text-muted-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground",
            className,
          )}
          aria-label={tooltip}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              dot,
              (status === "connecting" || status === "syncing" || status === "reconnecting") &&
                "animate-pulse"
            )}
          />
          <span className="leading-none">{label}</span>
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="end" className="w-72 gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>{t("editor.sync.connection")}</PopoverTitle>
          <PopoverDescription className="text-xs">{tooltip}</PopoverDescription>
        </PopoverHeader>
        <Separator />
        <dl className="flex flex-col gap-3 text-xs">
          {([
            [ArrowUp, t("editor.sync.upload"), formatRate(activity.upload)],
            [ArrowDown, t("editor.sync.download"), formatRate(activity.download)],
            [Clock3, t("editor.sync.responseTime"), !connected ? "—" : activity.latency == null
              ? t("editor.sync.waitingForActivity")
              : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(activity.latency)} ms`],
          ] as const).map(([Icon, label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground"><Icon className="size-3.5" aria-hidden="true" />{label}</dt>
              <dd className="text-end font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <Separator />
        <p className="text-xs leading-relaxed text-muted-foreground">{t("editor.sync.activityHelp")}</p>
      </PopoverContent>
    </Popover>
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
    case "syncing":
      return {
        dot: "bg-amber-500",
        labelKey: "editor.sync.syncing",
        tooltipKey: "editor.sync.syncingTooltip",
      }
    case "retrying":
      return {
        dot: "bg-red-500",
        labelKey: "editor.sync.retrying",
        tooltipKey: "editor.sync.retryingTooltip",
      }
    case "reconnecting":
      return {
        dot: "bg-amber-500",
        labelKey: "editor.sync.reconnecting",
        tooltipKey: "editor.sync.reconnectingTooltip",
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
