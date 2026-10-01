/**
 * DraftReviewOverview — the "Files changed" list above the one-cell review
 * editor (PR threads spec §4): every pending draft in document order by cell
 * reference, with its findings, so a reviewer sees the whole change and jumps
 * to any cell. Like a PR's changed-files list, it names cells; the text itself
 * lives in the editor card below.
 */

import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { DraftFindings } from "@/lib/agent/draft-findings"
import { DraftFindingChips } from "./DraftFindingChips"

export interface OverviewRow {
  draftId: string
  cellId: string
  label: string
  review: DraftFindings | undefined
}

export function DraftReviewOverview({ rows, selectedCellId, disabled, onSelect }: {
  rows: OverviewRow[]
  selectedCellId: string | null
  disabled: boolean
  onSelect: (cellId: string) => void
}) {
  const t = useT()
  return (
    <section className="flex flex-col gap-2" aria-label={t("agentDraftReview.filesChanged")} data-testid="draft-review-overview">
      <h3 className="text-sm font-semibold">{t("agentDraftReview.filesChanged")} · {rows.length}</h3>
      <ul className="flex max-h-64 flex-col divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
        {rows.map((row) => {
          const selected = row.cellId === selectedCellId
          return (
            <li key={row.draftId}>
              <button
                type="button"
                disabled={disabled}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(row.cellId)}
                className={cn(
                  "flex w-full flex-col gap-1 px-3 py-2 text-start transition-colors hover:bg-accent/40 disabled:opacity-60",
                  selected && "bg-accent",
                )}
              >
                <span className="text-xs font-medium">{row.label}</span>
                {row.review && row.review.findings.length > 0
                  ? <DraftFindingChips review={row.review} />
                  : <span className="text-[11px] text-muted-foreground">{t("agentDraftReview.noFindings")}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
