/**
 * A tool's attributed writes since T, and "revert everything since then".
 */

import { useCallback, useEffect, useState } from "react"
import { BadgeCheck, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useOutbox } from "@/context/OutboxContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { executeToolRevert, planFromActivity, type RevertOutcome } from "@/lib/tools/revert-run"
import type { RevertPlan } from "../../../shared/tools/revert"
import { fetchToolActivity, type ToolActivity, type ToolSummary } from "@/lib/tools/tools-api"

const HOUR = 60 * 60 * 1000

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export function ToolActivityPanel({
  projectId,
  tool,
  jwt,
  author,
}: {
  projectId: string
  tool: ToolSummary
  jwt: string
  author: string
}) {
  const t = useT()
  const { flushNow } = useOutbox()
  const [sinceMs, setSinceMs] = useState(() => Date.now() - 24 * HOUR)
  const [activity, setActivity] = useState<ToolActivity | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<RevertOutcome | null>(null)
  const [reverting, setReverting] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<RevertPlan | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setActivity(await fetchToolActivity(jwt, projectId, tool.id, sinceMs))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [jwt, projectId, tool.id, sinceMs])

  useEffect(() => {
    void load()
  }, [load])

  const prepareRevert = () => {
    if (!activity) return
    const plan = planFromActivity(activity)
    setOutcome(null)
    if (plan.commits.length === 0 && plan.unvalidates.length === 0) {
      setOutcome({ plan, restored: 0, unvalidated: 0 })
      return
    }
    setPendingPlan(plan)
  }

  const confirmRevert = async () => {
    if (!pendingPlan) return
    setReverting(true)
    try {
      setOutcome(await executeToolRevert({ projectId, toolId: tool.id, sinceMs, author, plan: pendingPlan, flush: flushNow }))
      setPendingPlan(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReverting(false)
    }
  }

  return (
    <section aria-label={t("tools.activity.heading")} className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{t("tools.activity.heading")}</h3>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {t("tools.activity.since")}
          <input
            type="datetime-local"
            className="rounded border bg-background px-1 py-0.5 text-foreground"
            value={toLocalInput(sinceMs)}
            onChange={(e) => {
              const ms = new Date(e.target.value).getTime()
              if (Number.isFinite(ms)) setSinceMs(ms)
            }}
          />
        </label>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="size-3.5" aria-hidden />
          {t("tools.activity.refresh")}
        </Button>
      </div>

      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
      {loading && !activity && <Spinner className="mt-2" />}
      {activity && activity.events.length === 0 && (
        <p className="mt-2 text-muted-foreground">{t("tools.activity.empty")}</p>
      )}
      {activity && activity.events.length > 0 && (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto" aria-label={t("tools.activity.heading")}>
          {[...activity.events].reverse().map((e) => {
            const cell = e.ref ?? e.cellId?.slice(0, 8) ?? ""
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-2 rounded bg-background px-2 py-1" data-testid="tool-activity-row">
                <span className="font-medium">
                  {e.kind === "target.cell.commit"
                    ? t("tools.activity.edit", { cell })
                    : e.kind === "cell.validate"
                      ? t("tools.activity.validate", { cell })
                      : t("tools.activity.other", { kind: e.kind, cell })}
                </span>
                {e.value !== null && <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.value}</span>}
                <span className="text-xs text-muted-foreground">{e.author}</span>
                <span className="text-xs text-muted-foreground">{fmtShortCalendarDate(e.serverTs)} {new Date(e.serverTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                {e.verified ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                    <BadgeCheck className="size-3.5" aria-hidden />
                    {t("tools.activity.verified", { version: e.version ?? "?" })}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                    <ShieldAlert className="size-3.5" aria-hidden />
                    {t("tools.activity.unverified")}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {activity?.truncated && <p className="mt-1 text-xs text-muted-foreground">{t("tools.activity.truncated")}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={prepareRevert} disabled={!activity || reverting || activity.events.length === 0}>
          <RotateCcw className="size-3.5" aria-hidden />
          {t("tools.revert.button")}
        </Button>
        {pendingPlan && (
          <span role="group" className="flex items-center gap-2">
            <span className="text-xs">{t("tools.revert.confirm", { count: pendingPlan.commits.length })}</span>
            <Button size="sm" variant="destructive" onClick={() => void confirmRevert()} disabled={reverting}>
              {reverting && <Spinner className="size-3.5" />}
              {t("common.confirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingPlan(null)} disabled={reverting}>
              {t("common.cancel")}
            </Button>
          </span>
        )}
        {outcome && (
          <span role="status" className="text-xs">
            {outcome.restored === 0 && outcome.unvalidated === 0 && outcome.plan.skipped.length === 0
              ? t("tools.revert.nothing")
              : t("tools.revert.done", { restored: outcome.restored })}
          </span>
        )}
      </div>
      {outcome && outcome.plan.skipped.length > 0 && (
        <div className="mt-2 text-xs" role="status">
          <p>{t("tools.revert.skippedHeading", { count: outcome.plan.skipped.length })}</p>
          <ul className="ml-4 list-disc">
            {outcome.plan.skipped.map((s) => (
              <li key={`${s.fileId}:${s.cellId}:${s.targetLang}`}>
                {t("tools.revert.skippedRow", { cell: s.cellId.slice(0, 8), by: s.by ?? "?" })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
