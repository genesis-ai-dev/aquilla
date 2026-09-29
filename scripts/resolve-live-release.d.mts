export interface LiveReleaseInput {
  /** Parsed aquilla.app/version.json, or anything that came back in its place. */
  version: unknown
  /** Full sha of the live commit if it exists on origin, else an empty string. */
  fullSha: string
  /** Whether that commit is an ancestor of origin/<the branch version.json names>. */
  onBranch: boolean
  /** Calver (`20*`) tags that point at the commit. */
  tags: string[]
}

export interface LiveReleaseDecision {
  action: "tag" | "skip" | "error"
  reason: string
  sha?: string
  branch?: string
  tags?: string[]
}

export function decideLiveRelease(input: LiveReleaseInput): LiveReleaseDecision
