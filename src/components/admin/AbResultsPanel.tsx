import { useCallback, useEffect, useRef, useState } from "react"
import { FlaskConical, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/page"
import { getAbResults, type AbResultRow } from "@/lib/frontier/admin"
import { cn } from "@/lib/utils"

/**
 * A/B experiment results — per-model outcomes from model_ab_events. The score
 * that matters is the acceptance rate among *decided* drafts (accepted vs
 * edited/rejected); drafts nobody has acted on yet are shown as pending, not
 * counted against either model. Error rate and latency come free from the
 * request log. Deliberately no significance test in v1 — the sample counts
 * are shown so the operator can judge whether a gap means anything yet.
 */
export function AbResultsPanel({ jwt }: { jwt: string }) {
  const [rows, setRows] = useState<AbResultRow[] | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (aliveRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const data = await getAbResults(jwt, days)
      if (aliveRef.current) setRows(data.results)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, days])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading && rows === null) {
    return <div className="h-24 animate-pulse rounded-lg border bg-card" />
  }
  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No experiment data yet"
        description="Rows appear as default-model requests are served while an experiment is enabled."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
              days === d
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {d}d
          </button>
        ))}
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh results"
          className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="ab-results-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Requests</th>
              <th className="px-3 py-2 font-medium">Avg edit</th>
              <th className="px-3 py-2 font-medium">Acceptance</th>
              <th className="px-3 py-2 text-right font-medium">Edited</th>
              <th className="px-3 py-2 text-right font-medium">Pending</th>
              <th className="px-3 py-2 text-right font-medium">Errors</th>
              <th className="px-3 py-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ResultRow key={`${r.arm}:${r.model}`} row={r} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Avg edit = how much of the model's draft humans rewrote before settling (0% = kept
        verbatim) — the primary quality signal, lower is better. Acceptance = validated without
        edits, as a share of drafts someone acted on. Small samples swing wildly — compare only
        once both arms have a few dozen decided drafts.
      </p>
    </div>
  )
}

function ResultRow({ row }: { row: AbResultRow }) {
  const decided = row.accepted + row.edited + row.rejected
  const pending = row.requests - row.errors - decided
  const acceptPct = decided > 0 ? Math.round((row.accepted / decided) * 100) : null

  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">{row.model}</span>
          <Badge variant={row.arm === "challenger" ? "default" : "secondary"} className="text-[10px]">
            {row.arm}
          </Badge>
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.requests.toLocaleString()}</td>
      <td className="px-3 py-2">
        <EditDistanceCell value={row.avgEditDistance} />
      </td>
      <td className="px-3 py-2">
        {acceptPct == null ? (
          <span className="text-xs text-muted-foreground">no decisions yet</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  acceptPct >= 70 ? "bg-emerald-500" : acceptPct >= 40 ? "bg-primary" : "bg-amber-500",
                )}
                style={{ width: `${acceptPct}%` }}
                aria-hidden
              />
            </div>
            <span className="text-xs tabular-nums">
              {acceptPct}%{" "}
              <span className="text-muted-foreground">
                ({row.accepted}/{decided})
              </span>
            </span>
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.edited}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{Math.max(0, pending)}</td>
      <td className={cn("px-3 py-2 text-right tabular-nums", row.errors > 0 && "text-destructive")}>
        {row.errors}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {row.avgLatencyMs == null ? "—" : `${(row.avgLatencyMs / 1000).toFixed(1)}s`}
      </td>
    </tr>
  )
}

/**
 * Mean normalized edit distance as "% of the draft humans rewrote" — the
 * primary quality signal (lower = better). Green under 15%, amber under 40%,
 * red beyond: past ~40% the model is drafting more noise than help.
 */
function EditDistanceCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>
  const pct = Math.round(value * 100)
  const color = pct <= 15 ? "bg-emerald-500" : pct <= 40 ? "bg-amber-500" : "bg-destructive"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.min(100, pct)}%` }} aria-hidden />
      </div>
      <span className="text-xs tabular-nums">{pct}%</span>
    </div>
  )
}
