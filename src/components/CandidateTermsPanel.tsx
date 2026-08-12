/**
 * CandidateTermsPanel — presentational ranked list of mined candidate terms.
 *
 * Surfaces likely key terms a translator should manage, scored by the
 * term-extraction stack in `@/lib/terminology/candidates` (C-value / NC-value /
 * G² keyness). Default ordering is NC-value descending (the caller passes the
 * already-ranked array). Each row offers a one-click "Promote to managed"
 * action that crosses the candidate into the controlled Concept vocabulary.
 *
 * Deliberately dumb: no data fetching, no store writes, no routing. Mounting
 * and wiring (running extractCandidates over the loaded-cells corpus, handling
 * promote → draft Concept) is the glue wave's job.
 *
 * SWARM-TODO(glue): mount this in the terminology view (TerminologyPage.tsx),
 *   feeding it `extractCandidates(corpus, { managed, reference })` over the
 *   loaded source/WIP cells, and wire `onPromote` to create a draft Concept via
 *   `addConcept`. Surface the coverage cap ("ranked over loaded cells only")
 *   and the chosen G² baseline near this panel per the spec.
 */

import { ArrowUpRight, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { CandidateTerm } from "@/lib/terminology/candidates"
import { useT } from "@/lib/i18n/I18nProvider"

export interface CandidateTermsPanelProps {
  /** Ranked candidate terms (already sorted, typically by NC-value desc). */
  candidates: CandidateTerm[]
  /** Promote a candidate into the managed Concept vocabulary. */
  onPromote: (term: CandidateTerm) => void
}

function ScoreCell({
  label,
  value,
  title,
}: {
  label: string
  value: number
  title: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex flex-col items-end tabular-nums" />}>
        <span className="text-[10px] text-muted-foreground">
          {label}
        </span>
        <span className="text-sm font-medium">{value}</span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

export function CandidateTermsPanel({
  candidates,
  onPromote,
}: CandidateTermsPanelProps) {
  const t = useT()
  if (candidates.length === 0) {
    return (
      <EmptyState
        variant="panel"
        className="rounded-lg py-10"
        icon={Sparkles}
        title={t("terminology.candidates.emptyTitle")}
        titleClassName="sr-only"
        description={t("terminology.candidates.emptyDescription")}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Sparkles className="h-4 w-4" aria-hidden />
        <span>
          {t("terminology.candidates.countRankedByNc", { count: candidates.length })}
        </span>
      </div>

      <ul className="flex flex-col divide-y rounded-lg border">
        {candidates.map((c) => (
          <li
            key={c.term}
            className={cn(
              "flex items-center gap-4 px-3 py-2.5",
              c.isManaged && "opacity-60",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{c.term}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t("terminology.candidates.ngramLength", { count: c.ngramLength })}
                </Badge>
                {c.isManaged && (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {t("terminology.common.managed")}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("terminology.common.occurrenceCount", { count: c.frequency })}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <ScoreCell
                label="NC"
                value={c.ncValue}
                title={t("terminology.candidates.ncTooltip")}
              />
              <ScoreCell
                label="C"
                value={c.cValue}
                title={t("terminology.candidates.cTooltip")}
              />
              <ScoreCell
                label="G²"
                value={c.g2}
                title={t("terminology.candidates.g2Tooltip")}
              />
            </div>

            <Button
              size="sm"
              variant={c.isManaged ? "ghost" : "outline"}
              disabled={c.isManaged}
              onClick={() => onPromote(c)}
              className="shrink-0"
            >
              <ArrowUpRight className="me-1 h-3.5 w-3.5" aria-hidden />
              {c.isManaged
                ? t("terminology.common.managed")
                : t("terminology.candidates.promoteButton")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
