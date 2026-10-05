/**
 * Which target language the file-target import fills (AQU-1631).
 *
 * The import used to write into whatever lane the editor happened to have
 * open, named only in passing — on a project with several target languages a
 * translator could pour a finished translation into the wrong one and not find
 * out until they switched lanes. So the destination is now a choice, shown
 * before a file is picked and defaulted to the open lane.
 *
 * Choosing a lane here switches the editor to it (`onValueChange` →
 * `setActiveLane`), which is what keeps the import correct rather than merely
 * labelled: the review step's "current translation", the conflict ticks and
 * every `target.cell.commit` parent (AD-2) come from the open lane's cells, so
 * the destination and the loaded cells have to be the same lane. While those
 * cells are still arriving the file picker stays disabled — matching against
 * the previous lane's heads would commit onto the wrong chain.
 *
 * The picker is `LaneCombobox` like every other lane picker (AQU-609), and
 * hidden entirely when there is only one lane to choose.
 */

import { ChevronDown } from "lucide-react"
import { LaneCombobox, type LaneComboboxOption } from "@/components/LaneCombobox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"

export interface FileTargetLanePickerProps {
  /** Lanes the user may send this import to, in registry order. */
  options: readonly LaneComboboxOption[]
  /** The lane the import will fill — the open one until the user changes it. */
  value: string
  onValueChange: (lane: string) => void
  /** True while the chosen lane's cells are still loading. */
  loading?: boolean
}

export function FileTargetLanePicker({
  options,
  value,
  onValueChange,
  loading = false,
}: FileTargetLanePickerProps) {
  const t = useT()
  if (options.length < 2) return null
  const selected = options.find((o) => o.value === value)
  return (
    <Field data-testid="file-target-lane-picker">
      <FieldLabel>{t("importExport.fileTarget.laneLabel")}</FieldLabel>
      <LaneCombobox
        options={options}
        value={value}
        onValueChange={onValueChange}
        searchPlaceholder={t("editor.lane.searchPlaceholder")}
        searchAriaLabel={t("editor.lane.searchAriaLabel")}
        emptyText={t("editor.lane.searchEmpty")}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="file-target-lane-trigger"
            aria-label={t("importExport.fileTarget.laneLabel")}
            className="w-full justify-between font-normal"
          >
            {selected?.label ?? value}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        }
      />
      <p className="text-xs text-muted-foreground">
        {loading
          ? t("importExport.fileTarget.laneLoading")
          : t("importExport.fileTarget.laneHint")}
      </p>
    </Field>
  )
}
