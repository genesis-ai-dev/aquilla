export const VERIFY_CHECK_NAME: string
/** The only check-run producer `release-verify` is accepted from. */
export const VERIFY_PRODUCER: string
/** State of the newest `release-verify` run GitHub Actions produced; undefined when there is none. */
export function verifyState(
  checkRuns: Array<{ name?: string; status?: string; conclusion?: string | null; started_at?: string; app?: { slug?: string } | null }> | unknown,
): string | undefined
/** Every comment on a commit, oldest first, across pages; throws rather than return a truncated list. */
export function commitComments(
  sha: string,
  token: string,
  api?: (path: string, token: string) => Promise<unknown>,
): Promise<Array<{ body?: unknown; user?: { login?: string } | null }>>

export type JevDecision = "fail" | "pass" | "inconclusive" | "unavailable"

/** The newest decision line in any smart-Jev marker comment, or null when none has posted. */
export const DEFAULT_JEV_TRUSTED_LOGINS: string[]
export function jevTrustedLogins(env?: Record<string, string | undefined>): string[]
/** Decision from a trusted author's marker comments: a FAIL holds; otherwise the newest wins. */
export function jevDecision(comments: Array<{ body?: unknown; login?: string }>, trustedLogins?: string[]): JevDecision | null

/** Whether the HEAD may deploy: release-verify must be `success` and Jev must have reported anything but FAIL. */
export function decide(input: { verify: string | undefined; jev: JevDecision | null }): { deploy: boolean; reason: string }

/** release/* branches on origin whose HEAD carries no calver tag. */
export function openReleaseBranches(): string[]
