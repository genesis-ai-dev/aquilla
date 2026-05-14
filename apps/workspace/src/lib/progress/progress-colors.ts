export type ProgressColorClass =
  | "text-editor-warning-foreground"
  | "text-charts-blue"
  | "text-charts-blue-dark"
  | "text-muted-foreground/80"
  | "text-muted-foreground/25"

export function getCompletedValidationLevels(
  validationLevels?: number[],
  requiredValidations?: number,
): number {
  if (!validationLevels || validationLevels.length === 0) return 0
  if (!requiredValidations) return 0
  let completedLevels = 0
  for (let i = 0; i < Math.min(validationLevels.length, requiredValidations); i++) {
    if (validationLevels[i] >= 100) completedLevels++
    else break
  }
  return completedLevels
}

export function getProgressColor(
  validatedPercent: number,
  completedPercent: number,
  validationLevels?: number[],
  requiredValidations?: number,
): ProgressColorClass {
  if (validatedPercent >= 100) return "text-editor-warning-foreground"
  if (completedPercent >= 100) {
    const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
    if (completedLevels >= 1) return "text-charts-blue-dark"
    return "text-charts-blue"
  }
  if (validatedPercent > 0 && validatedPercent < 100) return "text-muted-foreground/80"
  if (completedPercent > 0) return "text-muted-foreground/80"
  return "text-muted-foreground/25"
}

export function getProgressTitle(
  validatedPercent: number,
  completedPercent: number,
  _label: "Audio" | "Text",
  validationLevels?: number[],
  requiredValidations?: number,
): string {
  const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
  const validationLevelText =
    completedLevels > 0 ? `; ${completedLevels} level${completedLevels === 1 ? "" : "s"} of validation complete` : ""
  const translationPercent = Math.round(completedPercent)
  const validationPercent = Math.round(validatedPercent)
  return `Translation: ${translationPercent}%\nValidation: ${validationPercent}%${validationLevelText}`
}

export function getProgressDisplay(
  validatedPercent: number,
  completedPercent: number,
  label: "Audio" | "Text",
  validationLevels?: number[],
  requiredValidations?: number,
) {
  const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
  return {
    colorClass: getProgressColor(validatedPercent, completedPercent, validationLevels, requiredValidations),
    title: getProgressTitle(validatedPercent, completedPercent, label, validationLevels, requiredValidations),
    completedValidationLevels: completedLevels,
  }
}
