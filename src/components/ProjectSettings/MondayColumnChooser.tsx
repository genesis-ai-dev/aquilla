// "What should your board show?" — step 2 of the Monday setup, and the body of
// the linked board's "Add columns" dialog.
//
// One list of everything Aquilla can fill, in three short groups. Each row is a
// checkbox, a name and a tag: "On your board" for a column that's already there
// (it is used as it is) or "New column" for one Aquilla will create when the
// user confirms. What a column shows sits behind an ⓘ, so the list stays
// quiet. Aquilla ID is always included and can't be unticked. A live line
// under the list says how many columns get added and how many are reused.

import { useId, useState } from "react"
import { Info } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { MONDAY_COLUMN_CATALOG, metricOnBoard, type MondayColumnMapping, type MondayMetricKey } from "@/lib/monday/types"
import type { MondayBoardStructure } from "@/lib/monday/api"
import {
  MONDAY_COLUMN_GROUPS,
  REQUIRED_METRIC,
  columnSelectionCounts,
  type MondayColumnGroupKey,
} from "@/lib/monday/column-selection"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"

const GROUP_TITLE_KEY: Record<MondayColumnGroupKey, MessageKey> = {
  progress: "fileDetails.progress",
  schedule: "projectSettings.monday.chooser.groupSchedule",
  team: "projectSettings.monday.chooser.groupTeam",
}

const TITLE_BY_METRIC = new Map(MONDAY_COLUMN_CATALOG.map((c) => [c.metric, c.title]))

interface Props {
  /** The mapping so far (AI proposal, manual rows, or the saved link). */
  rows: MondayColumnMapping[]
  /** The board's columns when known; without them only mapped rows count as on the board. */
  boardColumns: MondayBoardStructure["columns"] | null | undefined
  boardName: string
  selected: ReadonlySet<MondayMetricKey>
  onChange: (next: Set<MondayMetricKey>) => void
  disabled?: boolean
  /** Hide the intro sentence (the linked board's dialog has its own). */
  hideIntro?: boolean
}

export function MondayColumnChooser({ rows, boardColumns, boardName, selected, onChange, disabled = false, hideIntro = false }: Props) {
  const t = useT()
  const { adds, uses } = columnSelectionCounts(selected, rows, boardColumns)

  function toggle(metric: MondayMetricKey, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(metric)
    else next.delete(metric)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="monday-column-chooser">
      {!hideIntro && <p>{t("projectSettings.monday.chooser.intro")}</p>}
      {MONDAY_COLUMN_GROUPS.map((group) => (
        <section key={group.key} className="flex flex-col gap-1" aria-labelledby={`monday-group-${group.key}`}>
          <h4 id={`monday-group-${group.key}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(GROUP_TITLE_KEY[group.key])}
          </h4>
          <ul className="flex flex-col">
            {group.metrics.map((metric) => (
              <ColumnRow
                key={metric}
                metric={metric}
                onBoard={metricOnBoard(metric, rows, boardColumns)}
                checked={selected.has(metric)}
                disabled={disabled}
                onToggle={(on) => toggle(metric, on)}
              />
            ))}
          </ul>
        </section>
      ))}
      <ul className="flex flex-col border-t pt-2">
        <ColumnRow
          metric={REQUIRED_METRIC}
          onBoard={metricOnBoard(REQUIRED_METRIC, rows, boardColumns)}
          checked
          locked
          disabled={disabled}
          note={t("projectSettings.monday.chooser.alwaysIncluded")}
          onToggle={() => {}}
        />
      </ul>
      <p role="status" aria-live="polite" className="font-medium" data-testid="monday-column-summary">
        {adds > 0
          ? t("projectSettings.monday.chooser.summaryAdds", { count: adds, board: boardName, uses })
          : t("projectSettings.monday.chooser.summaryNoAdds", { count: uses, board: boardName })}
      </p>
    </div>
  )
}

function ColumnRow({
  metric,
  onBoard,
  checked,
  locked = false,
  disabled,
  note,
  onToggle,
}: {
  metric: MondayMetricKey
  onBoard: boolean
  checked: boolean
  locked?: boolean
  disabled: boolean
  note?: string
  onToggle: (on: boolean) => void
}) {
  const t = useT()
  const [infoOpen, setInfoOpen] = useState(false)
  const id = useId()
  const labelId = `${id}-label`
  const infoId = `${id}-info`
  const title = TITLE_BY_METRIC.get(metric) ?? metric
  return (
    <li className="flex flex-col py-1" data-testid={`monday-column-${metric}`}>
      <div className="flex items-center gap-3">
        <Checkbox
          aria-labelledby={labelId}
          checked={checked}
          disabled={locked || disabled}
          onCheckedChange={(on) => onToggle(on === true)}
        />
        <span id={labelId} className="min-w-0 truncate">{title}</span>
        {onBoard ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t("projectSettings.monday.columnPickerOnBoard")}
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs",
              checked
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "border border-dashed text-muted-foreground",
            )}
          >
            {t("projectSettings.monday.chooser.newColumn")}
          </span>
        )}
        <button
          type="button"
          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={t("projectSettings.monday.chooser.infoAriaLabel", { column: title })}
          aria-expanded={infoOpen}
          aria-controls={infoId}
          data-state={infoOpen ? "open" : "closed"}
          onClick={() => setInfoOpen((v) => !v)}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </div>
      {note && <p className="ml-7 text-xs text-muted-foreground">{note}</p>}
      <p id={infoId} hidden={!infoOpen} className="ml-7 text-xs text-muted-foreground">
        {t(`projectSettings.monday.columnInfo.${metric}` as MessageKey)}
      </p>
    </li>
  )
}
