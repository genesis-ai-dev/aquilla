import type { ConnectionHistoryPoint } from "@/lib/sync/connection-activity"
import { useI18n } from "@/lib/i18n/I18nProvider"

const WIDTH = 288
const TOP = 4
const BOTTOM = 40
const x = (index: number) => 3 + index * (WIDTH - 6) / 59
const y = (value: number, max: number) => BOTTOM - value / max * (BOTTOM - TOP)

function trafficPath(history: ConnectionHistoryPoint[], key: "upload" | "download", max: number) {
  let penDown = false
  return history.map((point, index) => {
    const value = point[key]
    if (value == null) {
      penDown = false
      return ""
    }
    const command = `${penDown ? "L" : "M"}${x(index)},${y(value, max)}`
    penDown = true
    return command
  }).join(" ")
}

/** Separate scales: bytes/sec for traffic, milliseconds for observed replies.
 * Reply dots deliberately leave idle gaps; we never invent ping measurements. */
export function ConnectionHistoryChart({ history }: { history: ConnectionHistoryPoint[] }) {
  const { t, locale } = useI18n()
  const trafficMax = Math.max(1, ...history.flatMap(point => [point.upload ?? 0, point.download ?? 0]))
  const replyMax = Math.max(1, ...history.map(point => point.latency ?? 0))
  const hasTraffic = history.some(point => (point.upload ?? 0) > 0 || (point.download ?? 0) > 0)
  const hasReplies = history.some(point => point.latency != null)
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
  const rateScale = trafficMax >= 1_000_000 ? `${format(trafficMax / 1_000_000)} MB/s`
    : trafficMax >= 1_000 ? `${format(trafficMax / 1_000)} kB/s` : `${format(trafficMax)} B/s`

  // i18n-exempt ms is the standard unit symbol; the numeric value is locale-formatted.
  const replyScale = `${format(replyMax)} ms`

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <div className="flex gap-3">
          <span className="flex items-center gap-1"><span className="w-3 border-t-2 border-chart-1" />{t("editor.sync.upload")}</span>
          <span className="flex items-center gap-1"><span className="w-3 border-t-2 border-dashed border-chart-2" />{t("editor.sync.download")}</span>
        </div>
        <span className="tabular-nums">{hasTraffic ? rateScale : "—"}</span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} 44`} className="h-11 w-full" role="img" aria-label={t("editor.sync.trafficHistory")}>
        <path d={`M0,${TOP} H${WIDTH} M0,${BOTTOM} H${WIDTH}`} fill="none" className="stroke-border" />
        <path d={trafficPath(history, "upload", trafficMax)} fill="none" className="stroke-chart-1" strokeWidth="1.5" />
        <path d={trafficPath(history, "download", trafficMax)} fill="none" className="stroke-chart-2" strokeWidth="1.5" strokeDasharray="3 2" />
        {history.map((point, index) => (["upload", "download"] as const).map(key => {
          const value = point[key]
          return value != null && value > 0 ? <circle key={`${key}-${index}`} cx={x(index)} cy={y(value, trafficMax)} r="1.5" className={key === "upload" ? "fill-chart-1" : "fill-chart-2"} /> : null
        }))}
        {!hasTraffic && <text x={WIDTH / 2} y="25" textAnchor="middle" className="fill-muted-foreground text-[10px]">{t("editor.sync.waitingForActivity")}</text>}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{t("editor.sync.serverReply")}</span>
        <span className="tabular-nums">{hasReplies ? replyScale : "—"}</span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} 44`} className="h-11 w-full" role="img" aria-label={t("editor.sync.replyHistory")}>
        <path d={`M0,${TOP} H${WIDTH} M0,${BOTTOM} H${WIDTH}`} fill="none" className="stroke-border" />
        {history.map((point, index) => point.latency == null ? null : (
          <circle key={index} cx={x(index)} cy={y(point.latency, replyMax)} r="2" className="fill-foreground/70" />
        ))}
        {!hasReplies && <text x={WIDTH / 2} y="25" textAnchor="middle" className="fill-muted-foreground text-[10px]">{t("editor.sync.waitingForActivity")}</text>}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{t("editor.sync.fiveMinutesAgo")}</span>
        <span>{t("editor.sync.activityNow")}</span>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{t("editor.sync.historyHelp")}</p>
    </div>
  )
}
