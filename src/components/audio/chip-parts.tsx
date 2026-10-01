// The small parts a timeline take chip is built from, shared with every other
// waveform in the app. (AQU-1210 / AQU-1217, 2026-09-25)
//
// Sam's ruling: the timeline chip's look does not change, and every other place
// that draws a take — the Recording tab, the Audio view card, the recorder, the
// Voice-together split — is drawn as that same rectangle. These are the pieces
// both need: the 16px corner buttons, the validated tick and the preview
// playline. The timeline imports its class strings from here, so the two can
// never drift apart; the strings below are the timeline's own, byte for byte.

import type { ReactNode } from "react"
import { Check, CheckCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { CHIP_VALIDATED_BADGE_CLASS, chipCornerButtonClass } from "./chip-classes"

export interface ChipCornerButtonProps {
  side: "left" | "right"
  reveal?: "hover" | "always"
  label: string
  onActivate: () => void
  /** Pointer-down, before the click — the timeline primes its decode here. */
  onPress?: () => void
  disabled?: boolean
  testId?: string
  children: ReactNode
}

/**
 * A 16px round corner button, exactly the chip's.
 *
 * A `span role="button"`, not a `<button>`, for the same reason as on the chip:
 * it sits inside surfaces that are themselves pressable, and a real button
 * nested in one is invalid HTML. BOTH stopPropagation calls matter — without
 * them a press here also starts whatever the surface beneath does on press
 * (a drag on the timeline, a seek on a waveform).
 */
export function ChipCornerButton({
  side,
  reveal = "always",
  label,
  onActivate,
  onPress,
  disabled = false,
  testId,
  children,
}: ChipCornerButtonProps) {
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      title={label}
      aria-label={label}
      data-testid={testId}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (!disabled) onPress?.()
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onActivate()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          e.stopPropagation()
          if (!disabled) onActivate()
        }
      }}
      className={cn(chipCornerButtonClass(side, reveal), disabled && "opacity-50")}
    >
      {children}
    </span>
  )
}

/** The validated tick: a single check for your own vote below the threshold,
 *  a double one once the threshold is met. */
export function TakeValidatedBadge({
  state,
  label,
  testId,
}: {
  state: "self" | "full"
  label: string
  testId?: string
}) {
  return (
    <span data-testid={testId} title={label} aria-label={label} className={CHIP_VALIDATED_BADGE_CLASS}>
      {state === "full"
        ? <CheckCheck className="h-2.5 w-2.5" strokeWidth={3} />
        : <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
  )
}
