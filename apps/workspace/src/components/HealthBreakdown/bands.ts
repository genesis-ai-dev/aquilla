export function reviewedBand(penalty: number, cap: number): string {
  if (cap === 0 || penalty <= 0) return "Fully reviewed"
  const ratio = penalty / cap
  if (ratio >= 1) return "Not yet reviewed"
  return "Partially reviewed"
}

export function examplesBand(penalty: number, cap: number): string {
  if (cap === 0 || penalty <= 0) return "Strong lineage"
  const ratio = penalty / cap
  if (ratio >= 1) return "No examples"
  if (ratio >= 0.66) return "Weak lineage"
  return "Mixed lineage"
}

export function consistencyBand(penalty: number, cap: number): string {
  if (cap === 0 || penalty <= 0) return "Strong agreement"
  const ratio = penalty / cap
  if (ratio >= 1) return "No neighbors found"
  if (ratio >= 0.66) return "Weak agreement"
  return "Some agreement"
}

export function rulesBand(penalty: number, _cap: number, majorCount: number): string {
  if (penalty <= 0) return "Clean"
  if (majorCount > 0) return "Major issues"
  return "Minor issues"
}
