/** The commit status context the walk is reported under. */
export const WALK_STATUS_CONTEXT: string

/** The commit status for one planner walk value (PASS, none, fail, partial, unknown). */
export function walkStatus(walk: string): { state: "success" | "failure" | "pending"; description: string }
