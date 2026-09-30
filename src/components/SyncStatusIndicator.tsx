import { useState } from "react"
import { ArrowDown, ArrowUp, Info, Signal, SignalHigh, SignalLow, SignalMedium } from "lucide-react"
import { ConnectionDetails } from "./ConnectionDetails"
import { useConnectionFormat } from "@/hooks/useConnectionFormat"
import { useConnectionActivity } from "@/hooks/useConnectionActivity"
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ConnectionHistoryPoint } from "@/lib/sync/connection-activity"

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

const PING_ICON = { good: SignalHigh, fair: SignalMedium, slow: SignalLow } as const
const PING_CLASS = { good: "text-green-600 dark:text-green-400", fair: "text-amber-600 dark:text-amber-400", slow: "text-red-600 dark:text-red-400" } as const
const PING_KEY = { good: "editor.sync.qualityGood", fair: "editor.sync.qualityFair", slow: "editor.sync.qualitySlow" } as const

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
 *
 * Clicking opens a three-tile popover (upload, download, ping). Full telemetry
 * sits behind the (i) button so the everyday view stays glanceable.
 */
export function SyncStatusIndicator({ status, className }: SyncStatusIndicatorProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const activity = useConnectionActivity(open || detailsOpen)
  const { formatRate, formatLatency } = useConnectionFormat()
  const connected = status === "live" || status === "syncing" || status === "retrying"
  const quality = connected ? activity.quality : null
  const PingIcon = quality ? PING_ICON[quality] : Signal
  const { dot, labelKey, tooltipKey } = describeStatus(status)
  const label = t(labelKey)
  const tooltip = t(tooltipKey)
  const rows = [
    { key: "upload", Icon: ArrowUp, label: t("editor.sync.upload"), value: formatRate(activity.upload, connected) },
    { key: "download", Icon: ArrowDown, label: t("editor.sync.download"), value: formatRate(activity.download, connected) },
    { key: "ping", Icon: PingIcon, label: t("editor.sync.ping"), value: quality ? formatLatency(activity.latency) : "—",
      badge: quality ? t(PING_KEY[quality]) : null, className: quality ? PING_CLASS[quality] : "" },
  ]
  return (
    <>
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
        <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] gap-3 p-3">
          <PopoverHeader className="flex-row items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <PopoverTitle>{t("editor.sync.connection")}</PopoverTitle>
              <PopoverDescription className="text-xs">{tooltip}</PopoverDescription>
            </div>
            <button
              type="button"
              onClick={() => { setOpen(false); setDetailsOpen(true) }}
              aria-label={t("editor.sync.showDetails")}
              className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="size-4" aria-hidden="true" />
            </button>
          </PopoverHeader>
          <dl className="divide-y divide-border/70 rounded-md border border-border/70 text-xs">
            {rows.map(({ key, Icon, label, value, badge, className }) => (
              <div key={key} className="flex h-8 items-center gap-2 px-2">
                <Icon className={cn("size-3.5 shrink-0", className || "text-muted-foreground")} aria-hidden="true" />
                <dt className="flex-1 text-muted-foreground">{label}</dt>
                {key === "ping" && connected && <PingSparkline history={activity.history} />}
                {badge && <dd className={cn("text-[10px] font-medium", className)}>{badge}</dd>}
                <dd className="min-w-14 text-end font-mono tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
      <ConnectionDetails open={detailsOpen} onOpenChange={setDetailsOpen} activity={activity} connected={connected} statusText={tooltip} />
    </>
  )
}

/** Low-contrast trend of observed reply times; gaps are simply not drawn. */
function PingSparkline({ history }: { history: ConnectionHistoryPoint[] }) {
  const points = history.map((point, index) => [index, point.latency] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (points.length < 2) return null
  const max = Math.max(...points.map(([, ms]) => ms), 1)
  const d = points.map(([i, ms], n) => `${n ? "L" : "M"}${(i / 59 * 46 + 1).toFixed(1)},${(11 - ms / max * 10).toFixed(1)}`).join(" ")
  return (
    <svg viewBox="0 0 48 12" className="h-3 w-12 shrink-0" aria-hidden="true">
      <path d={d} fill="none" className="stroke-muted-foreground/40" strokeWidth="1" />
    </svg>
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
