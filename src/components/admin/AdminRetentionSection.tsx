import { useCallback, useEffect, useRef, useState } from "react"
import { Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Section, StatTile, STAT_TILE_GRID } from "@/components/ui/page"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { AdminSectionSkeleton } from "./shared"
import {
  getAdminRetention,
  sendAdminRetentionReport,
  type AdminRetention,
  type AdminWeeklyCohort,
} from "@/lib/frontier/admin"

/**
 * Retention tab — the growth numbers a platform operator actually steers by:
 * active users (DAU/WAU/MAU + stickiness), Day-N retention, a daily-active
 * series, and the weekly signup-cohort matrix (the "does the curve flatten?"
 * view). All figures come from GET /api/v2/admin/retention; the definitions
 * live in auth-worker/src/lib/retention.ts and are shared with the emailed
 * recap, which the buttons here send on demand.
 */
export function AdminRetentionSection({ jwt }: { jwt: string }) {
  const [days, setDays] = useState(90)
  const [data, setData] = useState<AdminRetention | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<"weekly" | "monthly" | null>(null)
  const [sentNote, setSentNote] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    getAdminRetention(jwt, days)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [jwt, days])

  const sendReport = useCallback(
    async (period: "weekly" | "monthly") => {
      setSending(period)
      setSentNote(null)
      try {
        const { subject } = await sendAdminRetentionReport(jwt, period)
        if (aliveRef.current) setSentNote(`Sent: ${subject}`)
      } catch (err) {
        if (aliveRef.current) setSentNote(err instanceof Error ? err.message : String(err))
      } finally {
        if (aliveRef.current) setSending(null)
      }
    },
    [jwt],
  )

  // AQU-942: once the numbers have resolved once, keep the shell — the Range
  // select lives inside it, so replacing the section with a bare error line
  // after a failed range change left the admin no control to change it back.
  // The error rides above the (last-good) figures instead.
  if (!data) {
    if (error) return <p className="text-sm text-destructive">{error}</p>
    return <AdminSectionSkeleton label="Loading retention" />
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className={STAT_TILE_GRID}>
        <StatTile label="Daily active" value={data.dau} hint={`avg ${fmt1(data.avgDau7)} over 7d`} />
        <StatTile label="Weekly active" value={data.wau} hint={`${data.newUsers7} new in 7d`} />
        <StatTile label="Monthly active" value={data.mau} hint={`${data.newUsers30} new in 30d`} />
        <StatTile label="Stickiness" value={pct(data.stickiness)} hint="avg DAU ÷ MAU" />
        <StatTile
          label="Day-7 retention"
          value={pct(data.retention.d7.rate)}
          hint={`${data.retention.d7.retained} of ${data.retention.d7.eligible} eligible`}
        />
        <StatTile
          label="Day-30 retention"
          value={pct(data.retention.d30.rate)}
          hint={`${data.retention.d30.retained} of ${data.retention.d30.eligible} eligible`}
        />
      </div>

      <Section
        title="Daily active users"
        description={`Distinct users who used the app each UTC day, ${data.daily[0]?.day} → ${data.asOf}.`}
        action={
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32" aria-label="Range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
              <SelectItem value="180">180 days</SelectItem>
              <SelectItem value="365">365 days</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        <DailyActiveChart daily={data.daily} />
      </Section>

      <Section
        title="Signup cohorts"
        description="Each row is a Monday-aligned signup week; cells show the share of that cohort active in week N after signup (week 0 = signup week). A curve that flattens above zero is retention; one that decays to zero is leakage."
        action={
          <div className="flex items-center gap-2">
            {sentNote && <span className="text-xs text-muted-foreground">{sentNote}</span>}
            <Button
              size="sm"
              variant="outline"
              disabled={sending != null}
              onClick={() => void sendReport("weekly")}
            >
              <Mail /> Email weekly recap
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={sending != null}
              onClick={() => void sendReport("monthly")}
            >
              <Mail /> Email monthly recap
            </Button>
          </div>
        }
        footer={
          <p className="text-xs text-muted-foreground">
            Platform admins are excluded from every figure. Days are UTC. Day-N retention is unbounded: a user counts
            as retained if active on day N or any later day. Recaps go out automatically to all platform admins every
            Monday (weekly) and on the 1st (monthly).
          </p>
        }
      >
        <CohortTable cohorts={data.cohorts} />
      </Section>
    </div>
  )
}

const pct = (rate: number | null): string => (rate == null ? "—" : `${Math.round(rate * 100)}%`)
const fmt1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/**
 * Single-series bar chart, inline SVG. One hue (the theme primary), thin
 * bars anchored to the baseline, hover reveals the exact day + count via a
 * native <title>. Weekly gridlines only — the eye reads the shape, the
 * tooltip reads the number.
 */
function DailyActiveChart({ daily }: { daily: AdminRetention["daily"] }) {
  const W = 800
  const H = 160
  const PAD_L = 28
  const PAD_B = 18
  const max = Math.max(1, ...daily.map((d) => d.active))
  const n = daily.length
  const slot = (W - PAD_L) / n
  const barW = Math.max(1, slot - 1)
  const plotH = H - PAD_B
  const y = (v: number) => plotH - (v / max) * plotH
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i)

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full min-w-[480px] text-primary"
        role="img"
        aria-label={`Daily active users, last ${n} days, peak ${max}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {t}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          const h = plotH - y(d.active)
          return (
            <rect
              key={d.day}
              x={PAD_L + i * slot}
              y={y(d.active)}
              width={barW}
              height={h}
              rx={h > 0 ? Math.min(2, barW / 2) : 0}
              fill="currentColor"
              opacity={d.active === 0 ? 0 : 1}
              data-testid="dau-bar"
              data-day={d.day}
              data-active={d.active}
            >
              <title>{`${d.day}: ${d.active} active`}</title>
            </rect>
          )
        })}
        {daily.map((d, i) =>
          i === 0 || i === n - 1 || (i % Math.max(7, Math.round(n / 8)) === 0 && i < n - 4) ? (
            <text
              key={`l-${d.day}`}
              x={PAD_L + i * slot + barW / 2}
              y={H - 4}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[10px]"
            >
              {d.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  )
}

/** Cohort matrix; newest week first; one sequential hue (primary) light→dark by share. */
function CohortTable({ cohorts }: { cohorts: AdminWeeklyCohort[] }) {
  const maxWeeks = Math.max(0, ...cohorts.map((c) => c.retained.length))
  const rows = [...cohorts].reverse()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="py-1 pr-3 text-left font-medium">Week of</th>
            <th className="py-1 pr-3 text-right font-medium">Signups</th>
            {Array.from({ length: maxWeeks }, (_, k) => (
              <th key={k} className="py-1 px-1 text-center font-medium">
                w{k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.weekStart} data-testid="cohort-row" data-week={c.weekStart}>
              <td className="py-1 pr-3 whitespace-nowrap">{c.weekStart}</td>
              <td className="py-1 pr-3 text-right">{c.size}</td>
              {Array.from({ length: maxWeeks }, (_, k) => {
                const n = c.retained[k]
                if (n == null) return <td key={k} />
                const share = c.size > 0 ? n / c.size : null
                return (
                  <td
                    key={k}
                    title={share == null ? "no signups" : `${n} of ${c.size}`}
                    className={cn(
                      "px-1 py-1 text-center",
                      share == null ? "text-muted-foreground" : share >= 0.6 ? "text-primary-foreground" : "",
                    )}
                    style={
                      share == null
                        ? undefined
                        : { backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round(share * 85 + 5)}%, transparent)` }
                    }
                  >
                    {share == null ? "—" : `${Math.round(share * 100)}%`}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
