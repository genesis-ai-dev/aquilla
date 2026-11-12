// Media redesign slice 1: the "Delivers" dropdown — Text, Audio, or Text and
// audio — on each target language row of Project settings → Languages and on
// each target language of the create dialog. What it decides is in
// src/lib/lanes/lane-delivers.ts.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LANE_DELIVERS, type LaneDelivers } from "@/lib/lanes/lane-delivers"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

function laneDeliversLabel(delivers: LaneDelivers, t: TFunction): string {
  switch (delivers) {
    case "audio":
      return t("projectSettings.languages.deliversAudio")
    case "text_and_audio":
      return t("projectSettings.languages.deliversTextAndAudio")
    default:
      return t("projectSettings.languages.deliversText")
  }
}

export interface LaneDeliversSelectProps {
  /** Null reads "Choose": a language that had "Records audio" on and has no choice yet. */
  value: LaneDelivers | null
  onValueChange: (delivers: LaneDelivers) => void
  /** The language's display name, for the control's accessible name. */
  laneLabel: string
  disabled?: boolean
  id?: string
  testId?: string
  className?: string
}

export function LaneDeliversSelect({
  value,
  onValueChange,
  laneLabel,
  disabled,
  id,
  testId,
  className,
}: LaneDeliversSelectProps) {
  const t = useT()
  // `items` lets the trigger show the chosen label before the popup has ever
  // been opened (Base UI resolves it from mounted items otherwise), and a null
  // value, never undefined, keeps the control controlled while nothing is
  // chosen — see UpstreamLaneChoiceField.
  const items = Object.fromEntries(LANE_DELIVERS.map((option) => [option, laneDeliversLabel(option, t)]))
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (next != null && next !== value) onValueChange(next as LaneDelivers)
      }}
    >
      <SelectTrigger
        id={id}
        size="sm"
        data-testid={testId}
        data-needs-choice={value == null ? "true" : undefined}
        aria-label={t("projectSettings.languages.deliversAriaLabel", { lane: laneLabel })}
        className={cn(
          "min-w-32 max-w-full bg-background",
          value == null && "border-amber-500 text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <SelectValue placeholder={t("projectSettings.languages.deliversChoose")} />
      </SelectTrigger>
      <SelectContent>
        {LANE_DELIVERS.map((option) => (
          <SelectItem key={option} value={option}>
            {laneDeliversLabel(option, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
