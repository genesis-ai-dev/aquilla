export type WalkVerdict = "PASS" | "FAIL" | "FLAKY" | "BLOCKED" | "NOT CHECKED"

// FLAKY and BLOCKED both mean the bot could not prove the outcome; the
// release planner holds on either exactly like a FAIL. NOT CHECKED means no
// UI claim to walk (scripts/CLI-only) and normalizes to "none", not a hold.
export function normalizeVerdict(verdict: string): "PASS" | "fail" | "none"

export interface ParsedWalkComment {
  prNumber: number
  /** The PR's own head sha, not the dev merge commit. */
  sha: string
  verdict: WalkVerdict
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
}

// Resolves one dev-branch merge commit to the walk verdict for the PR it
// closed. Returns "unknown" when that isn't possible yet: no associated PR,
// no matching comment, or a comment whose sha is stale.
export function lookupWalk(options: LookupWalkOptions): Promise<"PASS" | "fail" | "none" | "unknown">

// Fills `walk` for every PR still "unknown". One PR's lookup failing never
// blocks the others; it just stays "unknown", which holds.
export function fillWalks<T extends { sha: string; walk: string }>(
  prs: T[],
  opts: Omit<LookupWalkOptions, "mergeSha">,
): Promise<T[]>
