export type WalkVerdict = "PASS" | "FAIL" | "FLAKY" | "BLOCKED" | "NOT CHECKED"

// FLAKY and BLOCKED both mean the bot could not prove the outcome; the
// release planner holds on either exactly like a FAIL. NOT CHECKED means no
// UI claim to walk (scripts/CLI-only) and normalizes to "none", not a hold.
export function normalizeVerdict(verdict: string): "PASS" | "fail" | "none"

/** The planner's walk value for one parsed comment: a qualified PASS is "partial", which holds. */
export function walkOf(parsed: ParsedWalkComment): "PASS" | "fail" | "none" | "partial"

export interface ParsedWalkComment {
  /** Null for a marker-only comment ("<!-- aquilla-qa-walk <sha> -->"), which names no PR. */
  prNumber: number | null
  /** The PR's own head sha, not the dev merge commit. */
  sha: string
  verdict: WalkVerdict
  /** Set only on a PASS the bot qualified, e.g. "test level only": no live preview walk. */
  qualifier?: string
}

// Parses one comment body. Returns null for a comment that isn't a bot-walk
// comment, or whose verdict line doesn't parse, rather than guessing.
export function parseWalkComment(body: unknown): ParsedWalkComment | null

/** Minimal fetch shape lookupWalk/fillWalks need — real `fetch` satisfies it. */
export type FetchImpl = (
  url: string,
  init?: { redirect?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>

export interface LookupWalkOptions {
  /** The dev-branch merge commit to resolve to a walk verdict. */
  mergeSha: string
  repo?: string
  token: string
  fetchImpl?: FetchImpl
  /** Extra exact logins whose walk comments count; defaults to WALK_TRUSTED_LOGINS. */
  trustedLogins?: string[]
}

/** The `author_association` values whose walk comments the planner reads. */
export const WALK_TRUSTED_ASSOCIATIONS: string[]
/** Extra trusted logins from WALK_TRUSTED_LOGINS (comma separated); empty when unset. */
export function walkTrustedLogins(env?: Record<string, string | undefined>): string[]
/** Whether a PR comment's author may post a walk: a trusted association, or a listed login. */
export function isTrustedWalkAuthor(
  comment: { author_association?: string; user?: { login?: string } | null } | null | undefined,
  trustedLogins?: string[],
): boolean

/** The walk verdict, `release:approved` label and passed gate areas of the PR a dev merge closed. */
export function lookupPr(
  options: LookupWalkOptions,
): Promise<{ walk: "PASS" | "fail" | "none" | "partial" | "unknown"; approved: boolean; gates: string[] }>

/** The only check-run producer a gate is accepted from. */
export const GATE_PRODUCER: string

/** Areas whose AREA_GATES check, produced by GitHub Actions, concluded success on this head sha (newest run per name). */
export function passedGates(headSha: string, opts: Omit<LookupWalkOptions, "mergeSha">): Promise<string[]>

// Resolves one dev-branch merge commit to the walk verdict for the PR it
// closed. Returns "unknown" when that isn't possible yet: no associated PR,
// no matching comment, or a comment whose sha is stale.
export function lookupWalk(options: LookupWalkOptions): Promise<"PASS" | "fail" | "none" | "partial" | "unknown">

// Fills `walk` and `approved` for every PR. One PR's lookup failing never
// blocks the others; it just stays "unknown", which holds.
export function fillWalks<T extends { sha: string; walk: string }>(
  prs: T[],
  opts: Omit<LookupWalkOptions, "mergeSha">,
): Promise<(T & { approved?: boolean; gates?: string[] })[]>
