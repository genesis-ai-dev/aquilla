// Autopilot at the project level — the PM's answer to "what is the machine
// doing, and what is it waiting on my team for?"
//
// Every existing autopilot surface is scoped to one open file: the pill lives
// in the editor and dies with it. A project manager does not open files. They
// need one place that says how many books are drafting right now, how far along
// they are, and — the number that actually drives their week — how many
// verified drafts are sitting unreviewed across the whole project.
//
// It is also where a project-wide run starts. One file at a time is the wrong
// unit for the widest independent work in this product: files share no briefs,
// no cells, no ordering, so a whole project can draft at once.
//
// Read-only for viewers; starting requires the same CONTRIBUTOR floor the
// server enforces. Polls only while something is actually running — this page
// is not on the project WebSocket, and a dashboard that polls forever is a
// battery bug.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Loader2, Play, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  fetchContextualOverview,
  startProjectContextualRun,
  type ContextualOverview,
  type ContextualOverviewFile,
} from "@/lib/contextual/transport"

/** Statuses that mean work is in flight or waiting to resume. */
const ACTIVE_STATUSES = new Set(["running", "pausing", "paused", "parked"])

/** Poll cadence while anything is active. Slow enough to be free, fast enough
 *  that a PM watching a launch sees movement. */
const POLL_MS = 15_000

interface ProjectAutopilotPanelProps {
  projectId: string
  /** fileId → display name, from the overview's already-loaded file list. */
  fileNames: Map<string, string>
  /** CONTRIBUTOR (400) or above — mirrors the server's start gate. */
  canStart: boolean
}

function statusWords(status: string): string {
  switch (status) {
    case "running":
      return "Drafting"
    case "pausing":
      return "Finishing up"
    case "paused":
      return "Paused"
    case "parked":
      return "Watching"
    case "failed":
      return "Had problems"
    case "terminated":
      return "Stopped"
    default:
      return "Done"
  }
}

function statusTone(status: string): string {
  if (status === "running" || status === "pausing") return "text-primary"
  if (status === "failed") return "text-destructive"
  return "text-muted-foreground"
}

function FileRow({ row, name }: { row: ContextualOverviewFile; name: string }) {
  const pct = row.totalSpans > 0 ? Math.round((row.doneSpans / row.totalSpans) * 100) : 0
  return (
    <tr className="border-t border-border/60">
      <td className="max-w-52 truncate py-1.5 pr-3" title={name}>
        {name}
      </td>
      <td className={cn("py-1.5 pr-3 whitespace-nowrap", statusTone(row.status))}>
        {statusWords(row.status)}
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-muted-foreground">
            {row.doneSpans}/{row.totalSpans}
          </span>
        </div>
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">
        {row.proposedDrafts > 0 ? (
          <span className="font-medium text-primary">{row.proposedDrafts}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
        {row.appliedDrafts || "—"}
      </td>
    </tr>
  )
}

export function ProjectAutopilotPanel({
  projectId,
  fileNames,
  canStart,
}: ProjectAutopilotPanelProps) {
  const [overview, setOverview] = useState<ContextualOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Race guard: a poll resolving after the panel moved on must not write.
  const seqRef = useRef(0)

  // `error` belongs to start attempts alone — a refresh must never clear the
  // message explaining why the last start did nothing.
  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await fetchContextualOverview(projectId)
      if (seq !== seqRef.current) return
      setOverview(next)
    } catch {
      if (seq !== seqRef.current) return
      // A failed poll is not worth an error state — the last good snapshot is
      // still the truest thing we can show. Only a failed FIRST load matters.
      setOverview((prev) => prev ?? { ...EMPTY, available: false })
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const anyActive = useMemo(
    () => (overview?.files ?? []).some((f) => ACTIVE_STATUSES.has(f.status)),
    [overview],
  )

  // Poll only while something is moving.
  useEffect(() => {
    if (!anyActive) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [anyActive, load])

  const handleStart = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      const result = await startProjectContextualRun(projectId)
      if (result.started.length === 0 && result.skipped.length > 0) {
        setError("Autopilot is already running on every file with work left.")
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start autopilot.")
    } finally {
      setStarting(false)
    }
  }

  if (loading && !overview) {
    return (
      <div className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        <Spinner className="size-3.5" aria-hidden />
        Loading autopilot…
      </div>
    )
  }

  // Backend not deployed for this environment: say nothing rather than show a
  // dead panel on a page that is otherwise fully functional.
  if (!overview?.available) return null

  const { files, activeRuns, doneSpans, totalSpans, proposedDrafts, appliedDrafts, failedSpans } =
    overview
  const hasHistory = files.length > 0

  return (
    <div
      className="mt-6 rounded-lg border border-border bg-card p-4"
      data-testid="project-autopilot-panel"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          Autopilot
        </h3>
        {activeRuns > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-primary" data-testid="autopilot-active">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {activeRuns} {activeRuns === 1 ? "file" : "files"} drafting
          </span>
        )}
        {canStart && (
          <Button
            type="button"
            size="sm"
            variant={activeRuns > 0 ? "outline" : "default"}
            className="ml-auto"
            disabled={starting}
            onClick={() => void handleStart()}
          >
            {starting ? (
              <Spinner className="size-3.5" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            Draft the whole project
          </Button>
        )}
      </div>

      {/* The three numbers a PM actually acts on. */}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Waiting for review"
          value={proposedDrafts}
          tone={proposedDrafts > 0 ? "primary" : "muted"}
          hint="Verified drafts sitting in cells, unreviewed"
        />
        <Stat label="Accepted" value={appliedDrafts} tone="muted" hint="Drafts a person kept" />
        <Stat
          label="Passages drafted"
          value={totalSpans > 0 ? `${doneSpans}/${totalSpans}` : "—"}
          tone="muted"
          hint="Across every file autopilot has touched"
        />
        <Stat
          label="Needs a look"
          value={failedSpans}
          tone={failedSpans > 0 ? "warn" : "muted"}
          hint="Passages autopilot could not finish"
        />
      </div>

      {!hasHistory && (
        <p className="mt-4 text-xs text-muted-foreground">
          Autopilot hasn&apos;t run on this project yet. It reads whole passages, drafts them in
          context, and leaves each one in its cell for someone to accept.
        </p>
      )}

      {hasHistory && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pb-1.5 pr-3 font-medium">File</th>
                <th className="pb-1.5 pr-3 font-medium">Status</th>
                <th className="pb-1.5 pr-3 font-medium">Passages</th>
                <th className="pb-1.5 pr-3 text-right font-medium">To review</th>
                <th className="pb-1.5 text-right font-medium">Accepted</th>
              </tr>
            </thead>
            <tbody>
              {files.map((row) => (
                <FileRow
                  key={row.fileId}
                  row={row}
                  name={fileNames.get(row.fileId) ?? row.fileId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  )
}

const EMPTY: ContextualOverview = {
  available: false,
  files: [],
  activeRuns: 0,
  doneSpans: 0,
  totalSpans: 0,
  failedSpans: 0,
  unitsSpent: 0,
  proposedDrafts: 0,
  appliedDrafts: 0,
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: number | string
  tone: "primary" | "muted" | "warn"
  hint: string
}) {
  return (
    <AppTooltip content={hint}>
      <div>
        <div
          className={cn(
            "text-lg font-semibold tabular-nums",
            tone === "primary" && "text-primary",
            tone === "warn" && "text-amber-600 dark:text-amber-500",
            tone === "muted" && "text-foreground",
          )}
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </AppTooltip>
  )
}
