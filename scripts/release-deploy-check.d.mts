export const VERIFY_CHECK_NAME: string

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
