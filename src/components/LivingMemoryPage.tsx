/**
 * LivingMemoryPage — read-only surface showing the project's validated
 * source→target pairs as a living reference.
 *
 * SWARM-TODO(living-memory): add nav entry in ProjectWorkspace nav items
 *   (e.g. next to Rules / Comments) pointing to /project/:id/memory.
 */

import { useMemo } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, BookOpen, Users, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"
import { useLiveness } from "@/hooks/useLiveness"

// ── Skeleton placeholder while loading ────────────────────────────────────

function LivingMemorySkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading validated translations">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <CardContent className="p-3 flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────

function LivingMemoryEmpty() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-24 text-muted-foreground"
      role="status"
      aria-label="No validated translations"
    >
      <div className="rounded-2xl bg-muted/50 p-4">
        <BookOpen className="h-8 w-8 opacity-40" aria-hidden="true" />
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium text-foreground/70">No validated translations yet</p>
        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          Validated cells will appear here once translators and reviewers reach the required
          validation threshold.
        </p>
      </div>
    </div>
  )
}

// ── Single validated cell card ─────────────────────────────────────────────

function ValidatedCellCard({ cell }: { cell: LivingMemoryCell }) {
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-sm">
      <CardContent className="p-3 flex flex-col gap-1.5">
        {/* Reference label */}
        {cell.group && (
          <span
            className="text-[10px] font-mono text-muted-foreground/80 leading-none tracking-wide"
            aria-label={`Reference: ${cell.group}`}
          >
            {cell.group}
          </span>
        )}

        {/* Source text */}
        <p
          className="text-xs text-muted-foreground leading-relaxed"
          lang="und"
          aria-label="Source text"
        >
          {cell.original || <em className="opacity-50 not-italic">—</em>}
        </p>

        {/* Divider */}
        <div className="h-px bg-border/50 -mx-0.5" role="separator" aria-hidden="true" />

        {/* Target text */}
        <p className="text-sm leading-relaxed font-medium" aria-label="Translation">
          {cell.translated || <em className="text-muted-foreground opacity-50 not-italic">—</em>}
        </p>

        {/* Validators */}
        {cell.activeValidators.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-0.5"
            aria-label={`Validated by: ${cell.activeValidators.join(", ")}`}
          >
            <Users className="h-3 w-3 text-muted-foreground/60 shrink-0" aria-hidden="true" />
            {cell.activeValidators.map((v) => (
              <Badge key={v} variant="secondary" className="text-[10px] px-1.5 h-4 font-normal">
                {v}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── File group heading ──────────────────────────────────────────────────────

function FileGroupHeading({ fileName }: { fileName: string }) {
  return (
    <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-6 mb-2 px-0.5 first:mt-0 flex items-center gap-2">
      <span className="flex-1 truncate">{fileName}</span>
    </h2>
  )
}

// ── Grouped cell list ──────────────────────────────────────────────────────

function CellList({ cells }: { cells: LivingMemoryCell[] }) {
  // Group cells by file while preserving sort order.
  const groups = useMemo(() => {
    const seen: string[] = []
    const byFile = new Map<string, { fileName: string; cells: LivingMemoryCell[] }>()

    for (const cell of cells) {
      if (!byFile.has(cell.fileId)) {
        seen.push(cell.fileId)
        byFile.set(cell.fileId, { fileName: cell.fileName, cells: [] })
      }
      byFile.get(cell.fileId)!.cells.push(cell)
    }

    return seen.map((fileId) => byFile.get(fileId)!)
  }, [cells])

  return (
    <>
      {groups.map((group) => (
        <div key={group.fileName}>
          <FileGroupHeading fileName={group.fileName} />
          <div className="flex flex-col gap-2">
            {group.cells.map((cell) => (
              <ValidatedCellCard key={cell.id} cell={cell} />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function LivingMemoryPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { cells, isLoading, isEmpty, isTruncated, fileCount } = useLivingMemory({
    projectId: projectId ?? "",
  })

  const { state: livenessState, label: livenessLabel } = useLiveness(cells.length)

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="flex items-center gap-2 px-4 py-3 border-b shrink-0 bg-background/95 backdrop-blur-xs sticky top-0 z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => navigate(`/project/${projectId}`)}
          aria-label="Back to project"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold leading-none">Living Memory</h1>
          <p className="text-xs text-muted-foreground mt-0.5 leading-none">
            Confirmed source&thinsp;&rarr;&thinsp;target pairs
          </p>
        </div>
        {isLoading ? (
          <Skeleton className="h-5 w-20 rounded-full shrink-0" aria-label="Loading count" />
        ) : (
          <Badge variant="secondary" className="shrink-0 tabular-nums">
            {cells.length.toLocaleString()} validated
          </Badge>
        )}
        <span
          aria-label={livenessLabel}
          title={livenessLabel}
          className={[
            "h-2 w-2 shrink-0 rounded-full transition-colors",
            livenessState === "offline" ? "bg-red-500" :
            livenessState === "updating" ? "bg-amber-400 animate-pulse" :
            "bg-emerald-500",
          ].join(" ")}
        />
      </header>

      {/* Truncation warning */}
      {isTruncated && (
        <div
          className="flex items-start gap-2 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200/60 dark:border-amber-800/40"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            Showing cells from the first {fileCount} files.
            {/* SWARM-TODO(living-mem-server): replace fan-out with a dedicated
                GET /api/v2/projects/:projectId/validated-cells endpoint to
                support projects with >40 files. */}
          </span>
        </div>
      )}

      {/* Body — primary content scrolls with the window, not a nested
          container (see aquilla-specs 09-design-and-ux.md, "one primary
          scroll"). The sticky header stays pinned to the viewport top. */}
      <div className="flex-1">
        <div className="px-4 py-4 max-w-2xl mx-auto">
          {isLoading ? (
            <LivingMemorySkeleton />
          ) : isEmpty ? (
            <LivingMemoryEmpty />
          ) : (
            <CellList cells={cells} />
          )}
        </div>
      </div>
    </div>
  )
}
