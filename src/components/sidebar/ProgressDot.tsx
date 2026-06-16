import { getProgressDisplay } from "@/lib/progress/progress-colors"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const MAX_VALIDATION_LEVELS = 15

interface Props {
  label: string
  completedPercent: number
  validatedPercent: number
  validationLevels?: number[]
  requiredValidations?: number
  onClick?: () => void
}

/**
 * A single section dot. Size ~8px, colored per progress state, hover tooltip
 * shows exact numbers. Click navigates to the section.
 */
export function ProgressDot({
  label,
  completedPercent,
  validatedPercent,
  validationLevels,
  requiredValidations,
  onClick,
}: Props) {
  const display = getProgressDisplay(
    validatedPercent,
    completedPercent,
    "Text",
    validationLevels,
    requiredValidations,
  )

  // Progressive darkness for "dark blue" state — mirrors the desktop app.
  const isProgressive = display.colorClass === "text-charts-blue-dark"
  let filter = ""
  if (isProgressive) {
    const maxLevels = Math.min(requiredValidations || 1, MAX_VALIDATION_LEVELS)
    const brightness = Math.max(
      0.4,
      0.95 - 0.55 * (display.completedValidationLevels / maxLevels),
    )
    filter = `brightness(${brightness})`
  }

  return (
    <AppTooltip content={`${label}\n${display.title}`}>
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${display.title}`}
      className={cn(
        "h-2 w-2 rounded-full transition-opacity hover:opacity-80",
        display.colorClass,
      )}
      style={{
        backgroundColor: "currentColor",
        filter: filter || undefined,
      }}
    />
    </AppTooltip>
  )
}
