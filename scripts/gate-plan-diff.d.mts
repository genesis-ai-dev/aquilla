/** The part of a plan that decides a release, as comparable strings. */
export interface PlanShape {
  cut: boolean
  reason: string
  branch: string | null
  base: string | null
  ready: string[]
  held: string[]
}

/** One entry of a plan as either side prints it: a PR by number, a direct commit by sha. */
export interface PlanEntry {
  number?: number
  direct?: boolean
  sha?: string
  walk?: string
  areas?: string[]
  why?: string
}

export function planShape(plan: {
  cut: boolean
  reason: string
  branch?: string
  base?: string
  prs?: PlanEntry[]
  held?: PlanEntry[]
}): PlanShape

/** One line per differing field of two shapes; lists are compared entry by entry. */
export function shapeDiff(label: string, base: Record<string, unknown>, head: Record<string, unknown>): string[]
