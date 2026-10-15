// "What should your board show?" — step 2 of the Monday setup, and the body of
// the linked board's "Add columns" dialog.
//
// One list of everything Aquilla can fill, in three short groups. Each row is a
// checkbox, a name and a tag: "On your board" for a column that's already there
// (it is used as it is) or "New column" for one Aquilla will create when the
// user confirms. What a column shows is a short line under its name, always
// visible. Aquilla ID is always included and can't be unticked. A live line
// under the list says how many columns get added and how many are reused.
//
// The Airtable setup shows the same list for a table's fields (AQU-804):
// `profile` and `copy` carry its field types and words, Monday's by default.

import { useId } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { MONDAY_COLUMN_PROFILE, metricOnBoard, type MondayColumnMapping, type MondayMetricKey } from "@/lib/monday/types"
import type { MondayBoardStructure } from "@/lib/monday/api"
import {
  MONDAY_COLUMN_GROUPS,
  REQUIRED_METRIC,
  columnSelectionCounts,
  type MondayColumnGroupKey,
} from "@/lib/monday/column-selection"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"
import { MONDAY_CHOOSER_COPY, type ChooserCopy, type ColumnProfile } from "@/lib/integrations/sync-ui"

const GROUP_TITLE_KEY: Record<MondayColumnGroupKey, MessageKey> = {
  progress: "fileDetails.progress",
  schedule: "projectSettings.monday.chooser.groupSchedule",
  team: "projectSettings.monday.chooser.groupTeam",
}

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
  /** The provider's column types (Monday's by default). */
  profile?: ColumnProfile
  copy?: ChooserCopy
  /** Prefix of every test id in the list ("monday" by default). */
  testIdPrefix?: string
}

export function MondayColumnChooser({
  rows,
  boardColumns,
  boardName,
  selected,
  onChange,
  disabled = false,
  hideIntro = false,
  profile = MONDAY_COLUMN_PROFILE,
  copy = MONDAY_CHOOSER_COPY,
  testIdPrefix = "monday",
}: Props) {
  const t = useT()
  const { adds, uses } = columnSelectionCounts(selected, rows, boardColumns, profile)
  const titleByMetric = new Map(profile.catalog.map((c) => [c.metric, c.title]))
  const onBoard = (metric: MondayMetricKey) => metricOnBoard(metric, rows, boardColumns, profile)

  function toggle(metric: MondayMetricKey, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(metric)
    else next.delete(metric)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid={`${testIdPrefix}-column-chooser`}>
      {!hideIntro && <p>{t(copy.intro)}</p>}
      {MONDAY_COLUMN_GROUPS.map((group) => (
        <section key={group.key} className="flex flex-col gap-1" aria-labelledby={`${testIdPrefix}-group-${group.key}`}>
          <h4 id={`${testIdPrefix}-group-${group.key}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(GROUP_TITLE_KEY[group.key])}
          </h4>
          <ul className="flex flex-col">
            {group.metrics.map((metric) => (
              <ColumnRow
                key={metric}
                metric={metric}
                title={titleByMetric.get(metric) ?? metric}
                onBoard={onBoard(metric)}
                checked={selected.has(metric)}
                disabled={disabled}
                copy={copy}
                testIdPrefix={testIdPrefix}
                onToggle={(on) => toggle(metric, on)}
              />
            ))}
          </ul>
        </section>
      ))}
      <ul className="flex flex-col border-t pt-2">
        <ColumnRow
          metric={REQUIRED_METRIC}
          title={titleByMetric.get(REQUIRED_METRIC) ?? REQUIRED_METRIC}
          onBoard={onBoard(REQUIRED_METRIC)}
          checked
          locked
          disabled={disabled}
          note={t(copy.alwaysIncluded)}
          copy={copy}
          testIdPrefix={testIdPrefix}
          onToggle={() => {}}
        />
      </ul>
      <p role="status" aria-live="polite" className="font-medium" data-testid={`${testIdPrefix}-column-summary`}>
        {adds > 0
          ? t(copy.summaryAdds, { count: adds, board: boardName, uses })
          : t(copy.summaryNoAdds, { count: uses, board: boardName })}
      </p>
    </div>
  )
}

function ColumnRow({
  metric,
  title,
  onBoard,
  checked,
  locked = false,
  disabled,
  note,
  copy,
  testIdPrefix,
  onToggle,
}: {
  metric: MondayMetricKey
  title: string
  onBoard: boolean
  checked: boolean
  locked?: boolean
  disabled: boolean
  note?: string
  copy: ChooserCopy
  testIdPrefix: string
  onToggle: (on: boolean) => void
}) {
  const t = useT()
  const id = useId()
  const labelId = `${id}-label`
  const infoId = `${id}-info`
  return (
    <li className="flex items-start gap-3 py-1.5" data-testid={`${testIdPrefix}-column-${metric}`}>
      <Checkbox
        className="mt-0.5"
        aria-labelledby={labelId}
        aria-describedby={infoId}
        checked={checked}
        disabled={locked || disabled}
        onCheckedChange={(on) => onToggle(on === true)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId}>{title}</span>
          {onBoard ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t(copy.onBoard)}
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
              {t(copy.newColumn)}
            </span>
          )}
        </div>
        <p id={infoId} className="text-xs text-muted-foreground">
          {t(`projectSettings.monday.columnInfo.${metric}` as MessageKey)}
          {note && <> {note}</>}
        </p>
      </div>
    </li>
  )
}
