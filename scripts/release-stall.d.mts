export const INFRA_PATTERNS: RegExp[]

/** Whether a failed job's log reads as a runner or network fault rather than a failure in the code. */
export function isInfraFailure(log: string): boolean
/** The one line of a failed job's log worth quoting in an alert. */
export function failureExcerpt(log: string): string

export type StallDecision = {
  action: "rerun" | "alert"
  kind: "infra" | "code" | "unknown"
  reason: string
  jobs?: Array<{ name: string; infra: boolean; excerpt: string }>
}

/** Rerun once when every failed job is an infra fault on the first attempt; otherwise alert. */
export function decideStall(input: { jobs: Array<{ name: string; log: string }>; attempt: number }): StallDecision
