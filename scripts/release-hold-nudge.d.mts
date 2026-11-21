import type { HeldPr } from "./release-plan.mjs"

/**
 * The line to post when a held PR's wait crossed the limit in the last
 * `windowHours`, or null. Names each PR once: in the run its wait is in
 * [limitHours, limitHours + windowHours).
 */
export function holdNudge(
  plan: { held?: (Pick<HeldPr, "mergedAt" | "why"> & Partial<Pick<HeldPr, "number" | "direct" | "sha">>)[] },
  now: string,
  options?: { limitHours?: number; windowHours?: number },
): string | null
