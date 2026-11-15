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

/** The identity Worker's refusal code for the dev access list (auth-worker/src/services/dev-access.ts). */
export const DEV_ACCESS_RESTRICTED = "dev_access_restricted"

/** Written beside suite.json when global setup stops for a reason the PR comment may repeat. */
export const SETUP_FAILURE_FILE = "setup-failure.json"

/**
 * A global-setup failure whose message may be published: PR comments, run
 * logs and artifacts are public, so the message is built only from a
 * username, an HTTP status and a refusal code. Never wrap a caught error or
 * a response body in one.
 */
export class SetupFailure extends Error {}

/**
 * Why a bot account could not sign in. A dev-access refusal names the list,
 * because "HTTP 403" alone read as a broken harness for three days while the
 * accounts were simply not listed (AQU-2562).
 */
export function loginFailure(username: string, status: number, code: unknown): string {
  if (code !== DEV_ACCESS_RESTRICTED) return `login ${username} failed: HTTP ${status}`
  if (status === 403) {
    return `Sign-in was refused: ${username} is not on the dev access list (HTTP 403, ${DEV_ACCESS_RESTRICTED}). `
      + "A platform admin must add the account's email under dev → Admin → Platform → Dev access "
      + "(docs/security/preview-access.md)."
  }
  return `Sign-in was refused: the dev access list could not be read (HTTP ${status}, ${DEV_ACCESS_RESTRICTED}). `
    + "The target fails closed until its DEV_ACCESS_LIST binding answers."
}

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

/**
 * Driver reports that state, in so many words, that no input reached the page.
 * `jev_bridge.py` only ever emits its own vetted `safe_messages`, so matching
 * their wording is matching a closed set, not parsing free-form text.
 */
const NO_INPUT_REPORTED = /nothing typed|no action executed|without executing an unverified action/i

/**
 * The harness's own admission that it never exercised the product: an agent
 * whose driver stopped before entering the input it was driving at. The
 * product's behaviour was not observed, so nothing about it has been
 * established and no verdict may blame it (AQU-1513). Returns the driver's
 * reason, for the verdict to quote, or null when every agent did act.
 */
export function agentNeverActed(
  agents: readonly ({ errors?: readonly { reason?: unknown }[] } | null)[] | undefined,
): string | null {
  for (const agent of agents ?? []) {
    for (const error of agent?.errors ?? []) {
      if (typeof error.reason === "string" && NO_INPUT_REPORTED.test(error.reason)) return error.reason
    }
  }
  return null
}
