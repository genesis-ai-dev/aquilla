/**
 * Recent Examples — validated source→target pairs (read-only), grouped by
 * file. Rendered as the Living Memory "examples" pane. The section wrapper
 * keeps `aria-label="Recent Examples"` and the `role="status"` empty state —
 * both are load-bearing for tests/e2e.
 */

import { useMemo } from "react"
import { BookOpen, Users } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
import type { LivingMemoryCell } from "@/hooks/useLivingMemory"

// ── Skeleton placeholder while loading ────────────────────────────────────

function LivingMemorySkeleton() {
  const t = useT()
  return (
    <LoadingTemplate
      label={t("terminology.livingMemory.loadingValidatedTranslations")}
      className="min-h-96"
      templateClassName="min-h-96"
    >
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="overflow-hidden">
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    </LoadingTemplate>
  )
}

// ── Empty state for Recent Examples ───────────────────────────────────────

function RecentExamplesEmpty() {
  const t = useT()
  return (
    <EmptyState
      variant="inline"
      className="py-12"
      role="status"
      aria-label={t("terminology.livingMemory.noValidatedTranslationsAria")}
      icon={BookOpen}
      title={t("terminology.livingMemory.noValidatedTranslationsTitle")}
      titleClassName="text-foreground/70"
      description={t("terminology.livingMemory.noValidatedTranslationsDescription")}
      descriptionClassName="max-w-xs text-xs leading-relaxed"
    />
  )
}

// ── Single validated cell card ─────────────────────────────────────────────

function ValidatedCellCard({ cell }: { cell: LivingMemoryCell }) {
  const t = useT()
  return (
    <Card className="overflow-hidden transition-colors hover:bg-muted/50">
      <CardContent className="p-3 flex flex-col gap-1.5">
        {/* Reference label */}
        {cell.group && (
          <span
            className="text-[10px] font-mono text-muted-foreground/80 leading-none tracking-wide"
            aria-label={t("terminology.livingMemory.referenceAria", { reference: cell.group })}
          >
            {cell.group}
          </span>
        )}

        {/* Source text */}
        <p
          className="text-xs text-muted-foreground leading-relaxed"
          lang="und"
          aria-label={t("editor.source.textAria")}
        >
          {cell.original || <em className="opacity-50 not-italic">—</em>}
        </p>

        {/* Divider */}
        <div className="h-px bg-border/50 -mx-0.5" role="separator" aria-hidden="true" />

        {/* Target text */}
        <p
          className="text-sm leading-relaxed font-medium"
          aria-label={t("terminology.livingMemory.translationAria")}
        >
          {cell.translated || <em className="text-muted-foreground opacity-50 not-italic">—</em>}
        </p>

        {/* Validators */}
        {cell.activeValidators.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-0.5"
            aria-label={t("terminology.livingMemory.validatedByAria", {
              validators: cell.activeValidators.join(", "),
            })}
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
    <h3 className="text-xs font-semibold text-muted-foreground mt-6 mb-2 px-0.5 first:mt-0 flex items-center gap-2">
      <span className="flex-1 truncate">{fileName}</span>
    </h3>
  )
}

// ── Grouped cell list ──────────────────────────────────────────────────────

function CellList({ cells }: { cells: LivingMemoryCell[] }) {
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

// ── Section wrapper (the "examples" pane body) ─────────────────────────────

export function RecentExamplesSection({
  cells,
  isLoading,
  isEmpty,
}: {
  cells: LivingMemoryCell[]
  isLoading: boolean
  isEmpty: boolean
}) {
  const t = useT()
  return (
    <section aria-label={t("terminology.livingMemory.recentExamplesTitle")}>
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("terminology.livingMemory.recentExamplesTitle")}
        </h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
        {t("terminology.livingMemory.recentExamplesDescription")}
      </p>
      {isLoading ? (
        <LivingMemorySkeleton />
      ) : isEmpty ? (
        <RecentExamplesEmpty />
      ) : (
        <CellList cells={cells} />
      )}
    </section>
  )
}
