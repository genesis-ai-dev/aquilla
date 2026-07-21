export type StatusPieTone = "idle" | "partial" | "others"

/**
 * Apply to the validation toggle `Button`.
 * Kills the shared Button press nudge (`active:translate-y-px` + `transition-all`)
 * — twMerge does not treat the `not-aria-[haspopup]` variant as the same group as
 * plain `active:translate-y-*`, so we force transform off. No color fade either —
 * ghost bg snaps with the pie's group-hover preview. Hover well uses
 * `--status-pie-hover-bg` (set inline to an opacity of the pie accent).
 */
export const statusPieValidationButtonClass =
  "translate-y-0 transition-none active:translate-y-0 active:!translate-y-0 focus-visible:ring-0 hover:!bg-[var(--status-pie-hover-bg)] active:!bg-[var(--status-pie-hover-bg)]"

export function validationProgress(
  validatorCount: number,
  requirement: number,
): number {
  if (requirement <= 0) return 0
  return Math.min(1, validatorCount / requirement)
}

/** Quorum fill after the user adds their validation (one click). */
export function validationProgressAfterClick(
  validatorCount: number,
  requirement: number,
): number {
  const req = Math.max(1, requirement)
  return Math.min(1, (validatorCount + 1) / req)
}

/** Quorum fill after the user removes their validation (one click). */
export function validationProgressAfterUnvalidate(
  validatorCount: number,
  requirement: number,
): number {
  const req = Math.max(1, requirement)
  return Math.max(0, (validatorCount - 1) / req)
}

export function isFullValidationStatus(
  vs: "none" | "self" | "others" | "full" | "full-self" | "full-others" | "empty",
): boolean {
  // Green done glyph whenever quorum is met — by you or by others.
  return vs === "full-self" || vs === "full-others" || vs === "full"
}

export function validationPieTone(
  vs: "none" | "self" | "others" | "full" | "full-self" | "full-others" | "empty",
): StatusPieTone {
  // Colored fill only when you personally validated but quorum isn't met yet.
  // Others-only progress (including full-others) stays grey until full-self.
  if (vs === "self") return "partial"
  if (vs === "others" || vs === "full-others" || vs === "full") return "others"
  return "idle"
}
