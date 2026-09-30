import { ArrowDown, ArrowUp, Clock3 } from "lucide-react"
import { ConnectionHistoryChart } from "./ConnectionHistoryChart"
import type { getConnectionActivity } from "@/lib/sync/connection-activity"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useConnectionFormat } from "@/hooks/useConnectionFormat"

export type ConnectionActivity = ReturnType<typeof getConnectionActivity>

interface ConnectionDetailsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activity: ConnectionActivity
  connected: boolean
  statusText: string
}

/** Full telemetry: rolling totals, history chart, request counts. Opened from the (i) button. */
export function ConnectionDetails({ open, onOpenChange, activity, connected, statusText }: ConnectionDetailsProps) {
  const { t } = useI18n()
  const { formatBytes, formatRate, formatLatency } = useConnectionFormat()
  const lastReply = activity.lastReplyAgeMs == null ? t("editor.sync.waitingForActivity")
    : activity.lastReplyAgeMs < 1000 ? t("editor.sync.replyJustNow")
    : activity.lastReplyAgeMs < 60_000
      ? t("editor.sync.replySecondsAgo", { count: Math.floor(activity.lastReplyAgeMs / 1000) })
      : t("editor.sync.replyMinutesAgo", { count: Math.floor(activity.lastReplyAgeMs / 60_000) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editor.sync.connectionDetails")}</DialogTitle>
          <DialogDescription>{statusText}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_6rem] gap-2 text-end text-xs text-muted-foreground">
          <span aria-hidden="true" />
          <span>{t("editor.sync.activityNow")}</span>
          <span>{t("editor.sync.pastFiveMinutes")}</span>
        </div>
        <dl className="flex flex-col gap-3 text-xs">
          {([
            [ArrowUp, t("editor.sync.upload"), formatRate(activity.upload, connected),
              t("editor.sync.transferredTotal", { amount: formatBytes(activity.recent.upload) })],
            [ArrowDown, t("editor.sync.download"), formatRate(activity.download, connected),
              t("editor.sync.transferredTotal", { amount: formatBytes(activity.recent.download) })],
            [Clock3, t("editor.sync.serverReply"), connected ? formatLatency(activity.latency) : "—",
              activity.recent.averageLatency == null ? "—"
                : t("editor.sync.averageReply", { time: formatLatency(activity.recent.averageLatency) })],
          ] as const).map(([Icon, label, value, history]) => (
            <div key={label} className="grid grid-cols-[minmax(0,1fr)_5.5rem_6rem] items-center gap-2">
              <dt className="flex items-center gap-2 text-muted-foreground"><Icon className="size-3.5" aria-hidden="true" />{label}</dt>
              <dd className="text-end font-medium tabular-nums">{value}</dd>
              <dd className="text-end text-muted-foreground tabular-nums">{history}</dd>
            </div>
          ))}
        </dl>
        <ConnectionHistoryChart history={activity.history} />
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {activity.recent.slowestLatency != null && (
            <p>{t("editor.sync.slowestReply", { time: formatLatency(activity.recent.slowestLatency) })}</p>
          )}
          <p>{t("editor.sync.requestCount", { count: activity.recent.requests })}
            {" · "}<span className={cn(activity.recent.failures > 0 && "text-destructive")}>
              {t("editor.sync.failureCount", { count: activity.recent.failures })}
            </span>
          </p>
          <p>{lastReply}</p>
        </div>
        <Separator />
        <p className="text-xs leading-relaxed text-muted-foreground">{t("editor.sync.activityHelp")}</p>
      </DialogContent>
    </Dialog>
  )
}
