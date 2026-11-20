import type { ReleasePlan } from "./release-plan.mjs"

/** The part of a plan that decides a release, as comparable strings. */
export interface PlanShape {
  cut: boolean
  reason: string
  branch: string | null
  base: string | null
  ready: string[]
  held: string[]
}

export function planShape(plan: ReleasePlan): PlanShape

/** One line per differing field of two shapes; lists are compared entry by entry. */
export function shapeDiff(label: string, base: Record<string, unknown>, head: Record<string, unknown>): string[]
