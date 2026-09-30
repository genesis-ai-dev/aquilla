/** Pure evidence types and the harness-health rule, shared by the reporter and the PR comment. */

/** The evidence fields the reporter reads; run.ts and canary.spec.ts write them. */
export interface Evidence {
  canary?: boolean
  attackId?: string
  mode?: string
  journey?: string
  tags?: string[]
  goal?: string
  secondGoal?: string | null
  mutator?: string | null
  fuzzSeed?: number | null
  fingerprint?: string | null
  outcome: { verdict: string; reason: string; checks: Record<string, boolean>; diffs?: string[]; unmet?: string[] }
  projects: { projectId: string; owner: string }[]
  agents?: ({ status: string; errors?: { reason?: string }[] } | null)[]
}

export interface Recorded { project: string; status: string; evidence: Evidence | null }

/**
 * Decide whether the run said anything about the build. The canary must
 * have run and passed, and at least one attack must have reached a verdict.
 */
export function harnessHealth(recorded: Recorded[], attacksPlanned: number): { available: boolean; reason: string } {
  const canary = recorded.filter((entry) => entry.project === "canary")
  if (canary.length === 0) return { available: false, reason: "The canary health check did not run." }
  const failed = canary.filter((entry) => entry.status !== "passed")
  if (failed.length) return { available: false, reason: `The canary health check failed (${failed.length} of ${canary.length}).` }
  const attacks = recorded.filter((entry) => entry.project === "attacks")
  if (attacksPlanned > 0 && attacks.length === 0) return { available: false, reason: "No attack ran after the canary." }
  if (attacks.length > 0 && attacks.every((entry) => entry.evidence?.outcome.verdict === "inconclusive" || !entry.evidence)) {
    return { available: false, reason: "Every attack ended inconclusive." }
  }
  return { available: true, reason: "" }
}
