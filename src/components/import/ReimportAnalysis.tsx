import { CellNumberPill } from "@/components/cell/CellNumberPill"
import type { ReimportChangeCell, ReimportChangeCounts } from "@/lib/import/reimport-diff"
import { useT } from "@/lib/i18n/I18nProvider"

const SHOWN = 40

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return "—"
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat
}

function ChangeList({
  title,
  cells,
  showPrevious = false,
}: {
  title: string
  cells: readonly ReimportChangeCell[]
  showPrevious?: boolean
}) {
  const t = useT()
  const shown = cells.slice(0, SHOWN)
  const rest = cells.length - shown.length
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium">{title}</p>
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-xs">
          {shown.map((cell) => (
            <li key={`${cell.number}:${cell.text}`} className="text-foreground">
              <CellNumberPill number={cell.number} plain tint="major" />
              {" "}
              {showPrevious && cell.previous ? (
                <>
                  <span className="text-muted-foreground line-through">{clip(cell.previous)}</span>
                  {" → "}
                  {clip(cell.text)}
                </>
              ) : (
                clip(cell.text)
              )}
            </li>
          ))}
          {rest > 0 && (
            <li className="text-muted-foreground">{t("importExport.reimport.more", { count: rest })}</li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Added and updated cells, compared with the file being re-imported. */
export function ReimportAnalysis({ changes }: { changes: ReimportChangeCounts }) {
  const t = useT()
  return (
    <section
      className="flex max-h-64 w-full flex-col gap-3 overflow-y-auto rounded-md border border-border/60 p-3"
      data-testid="reimport-changes"
      aria-label={t("importExport.reimport.analysis")}
    >
      <h3 className="text-sm font-medium">{t("importExport.reimport.analysis")}</h3>
      <ChangeList
        title={t("importExport.reimport.added", { count: changes.added })}
        cells={changes.addedCells}
      />
      <ChangeList
        title={t("importExport.reimport.updated", { count: changes.updated })}
        cells={changes.updatedCells}
        showPrevious
      />
      {changes.added === 0 && changes.updated === 0 && (
        <p className="text-xs text-muted-foreground">{t("importExport.reimport.noChanges")}</p>
      )}
    </section>
  )
}
