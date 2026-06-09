/**
 * TerminologyViolationsInbox — by-concept terminology violations.
 *
 * Reuses the SHARED rule-engine: it compiles the project's active concepts to
 * TranslationRules (the same `compileConceptsToRules` path useRules uses) and
 * runs `checkRules` over the loaded project cells. The resulting infractions are
 * filtered to the stable `term:{conceptId}:` id scheme and grouped one-row-per-
 * concept by the pure `groupTerminologyInfractions` helper. No parallel engine.
 *
 * Evaluation is gated by the caller behind the active "Violations" tab (lazy),
 * mirroring the candidate-tab pattern, so the (super-linear-ish, regex-per-cell)
 * scan only runs when the user is looking at this surface.
 */
import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import { compileConceptsToRules } from "@/lib/terminology/compile"
import { checkRules } from "@/lib/rules/rule-engine"
import {
  groupTerminologyInfractions,
  type ConceptViolationGroup,
} from "@/lib/terminology/violations-inbox"

interface Props {
  concepts: Concept[]
  /** Loaded project cells (flattened across files). */
  cells: CellData[]
  /** Jump back to the editor focused on the offending cell, when supported. */
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
}

export function TerminologyViolationsInbox({ concepts, cells, onJumpToCell }: Props) {
  // Compile active concepts → rules and evaluate over the loaded cells. This is
  // the same derive-on-read path the editor uses; it only runs while mounted
  // (the caller mounts this only on the active Violations tab).
  const groups = useMemo<ConceptViolationGroup[]>(() => {
    const termRules = compileConceptsToRules(concepts)
    if (termRules.length === 0) return []
    const byFile = new Map<string, CellData[]>()
    for (const c of cells) {
      const arr = byFile.get(c.fileId)
      if (arr) arr.push(c)
      else byFile.set(c.fileId, [c])
    }
    const infractionMap = checkRules(byFile, termRules)
    const flat = [...infractionMap.values()].flat()
    return groupTerminologyInfractions(flat, concepts)
  }, [concepts, cells])

  const cellById = useMemo(() => {
    const m = new Map<string, CellData>()
    for (const c of cells) m.set(c.id, c)
    return m
  }, [cells])

  const totalViolations = useMemo(
    () => groups.reduce((s, g) => s + g.count, 0),
    [groups],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Violations
          {groups.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {totalViolations} across {groups.length} concept
              {groups.length === 1 ? "" : "s"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Terminology infractions derived on read over the loaded project cells,
          grouped by concept. Missing-approved = the source bears the concept but
          the target has no approved rendering. Forbidden-present = a forbidden
          rendering appears in the target.
        </p>

        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
            <ShieldAlert className="h-8 w-8 opacity-40" />
            <p className="text-sm">No terminology violations.</p>
            <p className="text-xs">
              Only <span className="font-medium">approved</span> concepts with
              renderings are enforced — set a concept's status to approved to
              start checking.
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {groups.map((g) => (
              <ConceptViolationRow
                key={g.conceptId}
                group={g}
                cellById={cellById}
                onJumpToCell={onJumpToCell}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ConceptViolationRow({
  group,
  cellById,
  onJumpToCell,
}: {
  group: ConceptViolationGroup
  cellById: Map<string, CellData>
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate text-sm font-medium">
          {group.sourceTerm}
        </span>
        <span className="shrink-0 rounded bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
          {group.count}
        </span>
        <span className="hidden shrink-0 gap-1.5 text-[10px] sm:flex">
          {group.missingApprovedCount > 0 && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              {group.missingApprovedCount} missing
            </span>
          )}
          {group.forbiddenPresentCount > 0 && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
              {group.forbiddenPresentCount} forbidden
            </span>
          )}
        </span>
      </button>

      {open && (
        <ul className="mt-2 space-y-1 pl-6">
          {group.infractions.map((inf, i) => {
            const cell = cellById.get(inf.cellId)
            const label = cell?.cellLabel ?? inf.cellId
            const preview = cell?.translated?.trim() || cell?.original?.trim() || ""
            return (
              <li
                key={`${inf.cellId}-${inf.ruleId}-${i}`}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    inf.kind === "forbidden-present"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
                  )}
                >
                  {inf.kind === "forbidden-present" ? "forbidden" : "missing"}
                </span>
                {onJumpToCell ? (
                  <button
                    type="button"
                    className="shrink-0 font-medium text-primary hover:underline"
                    onClick={() =>
                      onJumpToCell({ cellId: inf.cellId, fileId: inf.fileId })
                    }
                  >
                    {label}
                  </button>
                ) : (
                  <span className="shrink-0 font-medium">{label}</span>
                )}
                {preview && (
                  <span className="truncate text-muted-foreground">{preview}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
