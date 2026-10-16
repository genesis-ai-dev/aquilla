import { useI18n } from "@/lib/i18n/I18nProvider"
import type { LaneAccessChoice } from "@/lib/lanes/lane-access-choice"
import type { TargetLaneOption } from "@/hooks/useCurrentTargetLanes"

/**
 * AQU-1808: the sharer picks every current target lane, or names the ones
 * this person may use. Nothing is selected until they say so.
 */
export function LaneAccessFields({
  lanes,
  value,
  onChange,
  disabled = false,
  name = "lane-access",
}: {
  lanes: readonly TargetLaneOption[]
  value: LaneAccessChoice | null
  onChange: (next: LaneAccessChoice) => void
  disabled?: boolean
  /** Distinct per form when more than one picker is on the page. */
  name?: string
}) {
  const { t } = useI18n()
  if (lanes.length === 0) return null
  const selected = new Set(value?.kind === "lanes" ? value.laneIds : [])

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onChange({ kind: "lanes", laneIds: lanes.map((lane) => lane.id).filter((laneId) => next.has(laneId)) })
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium">{t("projectSettings.share.laneChoiceLegend")}</legend>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="radio"
          name={name}
          checked={value?.kind === "all"}
          onChange={() => onChange({ kind: "all" })}
        />
        {t("projectSettings.share.laneChoiceAll")}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="radio"
          name={name}
          checked={value?.kind === "lanes"}
          onChange={() => onChange({ kind: "lanes", laneIds: value?.kind === "lanes" ? value.laneIds : [] })}
        />
        {t("projectSettings.share.laneChoiceSome")}
      </label>
      {value?.kind === "lanes" && (
        <div className="space-y-1 ps-5">
          {lanes.map((lane) => (
            <label key={lane.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={selected.has(lane.id)}
                onChange={(event) => toggle(lane.id, event.target.checked)}
              />
              {lane.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}
