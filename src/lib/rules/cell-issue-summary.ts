import type { RuleInfraction } from "@/lib/parsers/types"

// AQU-757: a flagged cell's number pill tints by severity, but the tint alone
// explained nothing on hover ("Doesn't say squat"). These helpers turn the
// cell's active infractions — built-in integrity checks (number/punctuation/…)
// and user/terminology rules alike, since they all reduce to RuleInfraction —
// into the check name + plain-language reason surfaced in the hover tooltip.

export interface CellIssueLine {
  ruleId: string
  /** Human-readable check/rule name (falls back to the ruleId if unresolved). */
  name: string
  /** Plain-language reason the check fired, without the redundant name prefix. */
  reason: string
}

/** rule-engine stores infraction messages as `"<rule name>": <reason>`. When we
 *  render the name on its own line we drop that prefix so the reason isn't
 *  preceded by a duplicate of the heading. Messages without the prefix (e.g. a
 *  future check that omits it) pass through unchanged. */
export function infractionReason(message: string, ruleName: string): string {
  const prefix = `"${ruleName}": `
  return message.startsWith(prefix) ? message.slice(prefix.length) : message
}

/** Build the per-cell issue explanation shown when hovering the tinted cell
 *  number. One line per active infraction, in the order the checks ran. */
export function summarizeCellIssues(
  infractions: readonly RuleInfraction[],
  ruleName: (ruleId: string) => string | undefined,
): CellIssueLine[] {
  return infractions.map((inf) => {
    const name = ruleName(inf.ruleId) ?? inf.ruleId
    return { ruleId: inf.ruleId, name, reason: infractionReason(inf.message, name) }
  })
}
