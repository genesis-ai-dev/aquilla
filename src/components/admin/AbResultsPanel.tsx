import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { FlaskConical, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/ui/data-table"
import { EmptyState } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
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

  const columns = useMemo<ColumnDef<AbResultRow>[]>(
    () => [
      {
        id: "model",
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-foreground">{row.original.model}</span>
            <Badge
              variant={row.original.arm === "challenger" ? "default" : "secondary"}
              className="text-[10px]"
            >
              {row.original.arm}
            </Badge>
          </div>
        ),
      },
      {
        accessorKey: "requests",
        header: () => <div className="text-right">Requests</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.requests.toLocaleString()}</div>
        ),
      },
      {
        id: "avgEdit",
        accessorKey: "avgEditDistance",
        header: "Avg edit",
        cell: ({ row }) => <EditDistanceCell value={row.original.avgEditDistance} />,
      },
      {
        id: "acceptance",
        header: "Acceptance",
        cell: ({ row }) => {
          const r = row.original
          const decided = r.accepted + r.edited + r.rejected
          const acceptPct = decided > 0 ? Math.round((r.accepted / decided) * 100) : null
          if (acceptPct == null) {
            return <span className="text-xs text-muted-foreground">no decisions yet</span>
          }
          return (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-md",
                    acceptPct >= 70 ? "bg-emerald-500" : acceptPct >= 40 ? "bg-primary" : "bg-amber-500",
                  )}
                  style={{ width: `${acceptPct}%` }}
                  aria-hidden
                />
              </div>
              <span className="text-xs tabular-nums">
                {acceptPct}%{" "}
                <span className="text-muted-foreground">
                  ({r.accepted}/{decided})
                </span>
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: "edited",
        header: () => <div className="text-right">Edited</div>,
        cell: ({ row }) => <div className="text-right tabular-nums">{row.original.edited}</div>,
      },
      {
        id: "pending",
        header: () => <div className="text-right">Pending</div>,
        cell: ({ row }) => {
          const r = row.original
          const decided = r.accepted + r.edited + r.rejected
          const pending = r.requests - r.errors - decided
          return (
            <div className="text-right tabular-nums text-muted-foreground">
              {Math.max(0, pending)}
            </div>
          )
        },
      },
      {
        accessorKey: "errors",
        header: () => <div className="text-right">Errors</div>,
        cell: ({ row }) => (
          <div
            className={cn(
              "text-right tabular-nums",
              row.original.errors > 0 && "text-destructive",
            )}
          >
            {row.original.errors}
          </div>
        ),
      },
      {
        id: "latency",
        accessorKey: "avgLatencyMs",
        header: () => <div className="text-right">Latency</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {row.original.avgLatencyMs == null
              ? "—"
              : `${(row.original.avgLatencyMs / 1000).toFixed(1)}s`}
          </div>
        ),
      },
    ],
    [],
  )

  if (loading && rows === null) {
    return <Skeleton className="h-24 w-full rounded-lg" />
  }
  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={FlaskConical}
        title="No experiment data yet"
        description="Rows appear as default-model requests are served while an experiment is enabled."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {[7, 30, 90].map((d) => (
          <Button
            key={d}
            type="button"
            size="xs"
            variant={days === d ? "default" : "ghost"}
            onClick={() => setDays(d)}
          >
            {d}d
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={() => void refresh()}
          aria-label="Refresh results"
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => `${row.arm}:${row.model}`}
        testId="ab-results-table"
      />
      <p className="text-xs text-muted-foreground">
        Avg edit = how much of the model's draft humans rewrote before settling (0% = kept
        verbatim) — the primary quality signal, lower is better. Acceptance = validated without
        edits, as a share of drafts someone acted on. Small samples swing wildly — compare only
        once both arms have a few dozen decided drafts.
      </p>
    </div>
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
