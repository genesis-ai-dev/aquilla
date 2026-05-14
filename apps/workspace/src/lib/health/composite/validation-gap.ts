export function validationGap(activeCount: number, requiredValidations: number, cap: number): number {
  const required = Math.max(1, requiredValidations)
  const ratio = Math.min(activeCount / required, 1)
  return cap * (1 - ratio)
}
