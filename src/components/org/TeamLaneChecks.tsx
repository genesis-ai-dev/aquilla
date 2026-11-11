import { useEffect, useRef } from "react"
import type { TargetLaneOption } from "@/hooks/useCurrentTargetLanes"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * Checkbox per language lane, plus "All current language lanes". That box
 * checks the lanes that exist now and nothing more — the grant is saved as the
 * explicit list of those lane ids (`lanes_explicit`), so a lane added to the
 * project later is NOT granted. AQU-2481: the box used to borrow the status
 * filter's bare "All", which read as "every lane, forever"; it now has its own
 * key that says "current" out loud. Behaviour is unchanged.
 */
export function TeamLaneChecks({
  lanes,
  selected,
  onChange,
  disabled = false,
}: {
  lanes: readonly TargetLaneOption[]
  selected: readonly string[]
  onChange: (laneIds: string[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const allRef = useRef<HTMLInputElement>(null)
  const selectedSet = new Set(selected)
  const allChecked = lanes.length > 0 && lanes.every((lane) => selectedSet.has(lane.id))
  const someChecked = selected.length > 0 && !allChecked

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someChecked
  }, [someChecked])

  if (lanes.length === 0) return null

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(lanes.map((lane) => lane.id).filter((laneId) => next.has(laneId)))
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium">{t("projectSettings.share.laneChoiceLegend")}</legend>
      <label className="flex items-center gap-2 text-xs">
        <input
          ref={allRef}
          type="checkbox"
          checked={allChecked}
          onChange={(event) => onChange(event.target.checked ? lanes.map((lane) => lane.id) : [])}
        />
        {t("projectSettings.share.laneChoiceAllCurrent")}
      </label>
      {lanes.map((lane) => (
        <label key={lane.id} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={selectedSet.has(lane.id)}
            onChange={(event) => toggle(lane.id, event.target.checked)}
          />
          {lane.label}
        </label>
      ))}
    </fieldset>
  )
}
