/**
 * PostEditMetricsSection — AQU-311 AI metrics panel.
 *
 * Shows post-edit magnitude (normalized edit distance between AI drafts and
 * the final approved text) over time, with a by-reviewer breakdown.
 *
 * Surfaces as a section within ProjectSettings, alongside other project-level
 * stats. Reachable via the "AI Metrics" nav entry.
 *
 * DATA SOURCE: derives on read from the event log via usePostEditMetrics.
 * No new materialized columns; no sync-worker writes.
 *
 * APPROXIMATION NOTE: uses character-level normalized Levenshtein distance
 * (NED). NED=0 means the human accepted the AI draft unchanged; NED=1 means
 * the human completely replaced it. Values in between reflect partial edits.
 * Word-level TER would be more linguistically accurate for MTPE benchmarking
 * — see SWARM-TODO in edit-distance.ts.
 */

import { useMemo, useState } from "react"
import { AlertTriangle, Cloud, Sparkles } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { PostEditMetrics, WeekBucket, UserBucket } from "@/lib/metrics/post-edit-metrics"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { formatDate } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(ned: number): string {
  return `${Math.round(ned * 100)}%`
}

/** Effort-level bucket for a NED value, as a catalog key — resolve with t() at render. */
function nedLabelKey(ned: number): MessageKey {
  if (ned < 0.1) return "workspace.metrics.nedLabel.minimal"
  if (ned < 0.3) return "workspace.metrics.nedLabel.light"
  if (ned < 0.6) return "workspace.metrics.nedLabel.moderate"
  if (ned < 0.85) return "workspace.metrics.nedLabel.heavy"
  return "workspace.metrics.nedLabel.completeRewrite"
}

function nedColor(ned: number): string {
  if (ned < 0.1) return "bg-green-500"
  if (ned < 0.3) return "bg-lime-400"
  if (ned < 0.6) return "bg-yellow-400"
  if (ned < 0.85) return "bg-orange-400"
  return "bg-red-500"
}

function formatWeek(weekStart: string, locale: string): string {
  // "2024-01-08" → "Jan 8"
  const d = new Date(weekStart + "T00:00:00Z")
  return formatDate(d, locale, { month: "short", day: "numeric", timeZone: "UTC" })
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${(minutes / 60).toFixed(1)}h`
}

// ── Bar chart (weekly trend) ──────────────────────────────────────────────────

function WeeklyChart({ weeks }: { weeks: WeekBucket[] }) {
  const { locale, t } = useI18n()
  if (weeks.length === 0) return null
  const maxCount = Math.max(...weeks.map((w) => w.count), 1)

  return (
    <div className="mt-3 space-y-1">
      {weeks.map((w) => (
        <div key={w.weekStart} className="flex items-center gap-2 text-xs">
          <span className="w-14 shrink-0 text-muted-foreground">{formatWeek(w.weekStart, locale)}</span>
          {/* NED bar */}
          <div className="relative h-5 flex-1 rounded bg-muted/40">
            <div
              className={`h-full rounded ${nedColor(w.avgNed)} opacity-80 transition-all`}
              style={{ width: `${Math.max(2, w.avgNed * 100)}%` }}
            />
            <span className="absolute inset-0 flex items-center ps-2 text-[11px] font-medium leading-none text-foreground/80">
              {t("workspace.metrics.weekBarLabel", { pct: pct(w.avgNed) })}
            </span>
          </div>
          {/* Count pill */}
          <span className="w-16 shrink-0 text-end text-muted-foreground">
            {t("nav.outbox.summaryEdits", { count: w.count })}
            {/* Tiny bar proportional to count */}
            <span
              className="ms-1 inline-block h-1.5 rounded bg-muted-foreground/40 align-middle"
              style={{ width: `${Math.round((w.count / maxCount) * 32)}px` }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

// ── User table ────────────────────────────────────────────────────────────────

function UserTable({ users, activeUser, onSelectUser }: {
  users: UserBucket[]
  activeUser: string | null
  onSelectUser: (u: string | null) => void
}) {
  const { t } = useI18n()
  if (users.length === 0) return null

  return (
    <div className="mt-2 overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.role.reviewer", { count: 1 })}</TableHead>
            <TableHead className="text-end">{t("workspace.metrics.approvalsColumn")}</TableHead>
            <TableHead className="text-end">{t("workspace.metrics.avgEditDistanceColumn")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const isActive = activeUser === u.author
            return (
              <TableRow
                key={u.author}
                data-state={isActive ? "selected" : undefined}
                onClick={() => onSelectUser(isActive ? null : u.author)}
              >
                <TableCell className="font-mono text-xs">{u.author}</TableCell>
                <TableCell className="text-end text-muted-foreground">{u.count}</TableCell>
                <TableCell className="text-end">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`inline-block size-2 rounded-lg ${nedColor(u.avgNed)}`}
                    />
                    <span>{pct(u.avgNed)}</span>
                    <span className="text-xs text-muted-foreground">({t(nedLabelKey(u.avgNed))})</span>
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Empty / loading states ────────────────────────────────────────────────────

function MetricsEmptyState({ reason }: { reason: "no-data" | "error" | "no-cloud" }) {
  const { t } = useI18n()
  const config: Record<
    typeof reason,
    { icon: typeof Sparkles; title: string; description: string }
  > = {
    "no-data": {
      icon: Sparkles,
      title: t("workspace.metrics.emptyNoData.title"),
      description: t("workspace.metrics.emptyNoData.description"),
    },
    error: {
      icon: AlertTriangle,
      title: t("workspace.metrics.emptyError.title"),
      description: t("workspace.metrics.emptyError.description"),
    },
    "no-cloud": {
      icon: Cloud,
      title: t("workspace.metrics.emptyNoCloud.title"),
      description: t("workspace.metrics.emptyNoCloud.description"),
    },
  }
  const { icon, title, description } = config[reason]
  return (
    <EmptyState
      variant="inline"
      className="mt-3 py-4"
      icon={icon}
      title={title}
      description={description}
    />
  )
}

// ── Main section ──────────────────────────────────────────────────────────────

export interface PostEditMetricsSectionProps {
  metrics: PostEditMetrics | null
  isLoading: boolean
  isError: boolean
  isCloudProject: boolean
  onRevalidate: () => void
}

export function PostEditMetricsSection({
  metrics,
  isLoading,
  isError,
  isCloudProject,
  onRevalidate,
}: PostEditMetricsSectionProps) {
  const { t } = useI18n()
  const [activeUser, setActiveUser] = useState<string | null>(null)

  // If a user is selected in the user table, filter the weekly chart to that user's pairs.
  const filteredWeeks = useMemo(() => {
    if (!metrics) return []
    if (!activeUser) return metrics.byWeek

    // Re-bucket pairs filtered to activeUser.
    const filtered = metrics.pairs.filter((p) => p.author === activeUser)
    if (filtered.length === 0) return []

    // Re-aggregate without calling the full aggregatePostEditMetrics to avoid circular import.
    const weekMap = new Map<string, { sumNed: number; count: number }>()
    for (const p of filtered) {
      const wk = (() => {
        const d = new Date(p.humanTs)
        const day = d.getUTCDay()
        const diff = day === 0 ? 6 : day - 1
        const mon = new Date(d)
        mon.setUTCDate(d.getUTCDate() - diff)
        mon.setUTCHours(0, 0, 0, 0)
        return mon.toISOString().slice(0, 10)
      })()
      const entry = weekMap.get(wk) ?? { sumNed: 0, count: 0 }
      entry.sumNed += p.ned
      entry.count += 1
      weekMap.set(wk, entry)
    }
    return Array.from(weekMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, { sumNed, count }]) => ({
        weekStart,
        avgNed: sumNed / count,
        count,
      }))
  }, [metrics, activeUser])

  return (
    <section id="section-ai-metrics" aria-labelledby="ai-metrics-heading">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle id="ai-metrics-heading" className="text-base">
              {t("workspace.metrics.cardTitle")}
            </CardTitle>
            {!isLoading && (
              <button
                type="button"
                onClick={onRevalidate}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {t("common.refresh")}
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("workspace.metrics.cardSubtitle")}{" "}
            <span className="italic">{t("workspace.metrics.nedScale")}</span>
          </p>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-2 pt-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {!isLoading && !isCloudProject && <MetricsEmptyState reason="no-cloud" />}

          {!isLoading && isCloudProject && isError && <MetricsEmptyState reason="error" />}

          {!isLoading && isCloudProject && !isError && metrics?.totalCount === 0 && (
            <MetricsEmptyState reason="no-data" />
          )}

          {!isLoading && isCloudProject && !isError && metrics && metrics.totalCount > 0 && (
            <>
              {/* Summary row */}
              <div className="flex flex-wrap gap-3 pb-1 pt-2">
                <div className="rounded-md border px-3 py-2 text-center">
                  <div className="text-xl font-semibold tabular-nums">
                    {pct(metrics.overallAvgNed)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("workspace.metrics.overallAvgNedLabel")}</div>
                </div>
                <div className="rounded-md border px-3 py-2 text-center">
                  <div className="text-xl font-semibold tabular-nums">{metrics.totalCount}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("workspace.metrics.approvedPairsLabel")}</div>
                </div>
                <div className="rounded-md border px-3 py-2 text-center">
                  <div className="text-xl font-semibold tabular-nums">{pct(metrics.acceptanceRate)}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("workspace.metrics.acceptedAsIsLabel")}</div>
                </div>
                <div className="rounded-md border px-3 py-2 text-center">
                  <div className="text-xl font-semibold tabular-nums">{formatDuration(metrics.overallAvgReviewMs)}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("workspace.metrics.avgReviewTimeLabel")}</div>
                </div>
                <div className="rounded-md border px-3 py-2 text-center">
                  <div className="text-xl font-semibold">
                    <Badge
                      variant="outline"
                      className={`border-0 ${nedColor(metrics.overallAvgNed)} text-white`}
                    >
                      {t(nedLabelKey(metrics.overallAvgNed))}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("workspace.metrics.effortLevelLabel")}</div>
                </div>
              </div>

              {/* Weekly trend chart */}
              <div className="mt-4">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {t("workspace.metrics.weeklyTrendHeading")}
                  {activeUser && (
                    <span className="ms-1 normal-case font-normal">
                      <RichMessage
                        k="workspace.metrics.filteredTo"
                        values={{ user: <span className="font-mono">{activeUser}</span> }}
                      />
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => setActiveUser(null)}
                      >
                        {t("common.clear")}
                      </button>
                    </span>
                  )}
                </h4>
                {filteredWeeks.length > 0 ? (
                  <WeeklyChart weeks={filteredWeeks} />
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">{t("workspace.metrics.noUserData")}</p>
                )}
              </div>

              {/* By-user table */}
              {metrics.byUser.length > 0 && (
                <div className="mt-5">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {t("workspace.metrics.byReviewerHeading")}
                    <span className="ms-1 normal-case font-normal text-muted-foreground">
                      {t("workspace.metrics.byReviewerHint")}
                    </span>
                  </h4>
                  <UserTable
                    users={metrics.byUser}
                    activeUser={activeUser}
                    onSelectUser={setActiveUser}
                  />
                </div>
              )}

              {/* Approximation disclosure */}
              <p className="mt-4 text-[11px] text-muted-foreground/70">
                {t("workspace.metrics.disclosure")}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
