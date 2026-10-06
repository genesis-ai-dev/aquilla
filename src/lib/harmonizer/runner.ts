// Harmonizer runner — every check's questions in ONE Jev request per passage
// (AQU-1657). Batching is what makes a check per passage affordable (TypeSafe's
// parallel-questions study: same answers, a fraction of the cost); the cells go
// into `state` once and each check's questions refer to them by label.
//
// Shared by auth-worker's /api/v1/ai/harmonize route and any eval script, so an
// eval measures exactly what production asks. Alias-free.

import { quotationCheck } from "./quotes"
import { referenceCheck } from "./reference"
import type { HarmonizerCell, HarmonizerFinding, HarmonizerQuestion, HarmonyCheck } from "./types"

/** Registered checks. Order is the order findings are reported in. */
export const CHECKS: readonly HarmonyCheck<unknown>[] = [
  quotationCheck as HarmonyCheck<unknown>,
  referenceCheck as HarmonyCheck<unknown>,
]

export interface HarmonizerJevRequest {
  model: string
  state: { cells: { index: number; ref?: string; source: string; target: string }[] }
  questions: Record<string, HarmonizerQuestion>
}

export interface PlannedRun {
  /** null when no check has anything to ask — skip the call entirely. */
  request: HarmonizerJevRequest | null
  plans: { check: HarmonyCheck<unknown>; plan: unknown; prefix: string }[]
}

const prefixFor = (i: number) => `h${i}_`

export function planHarmonizer(
  cells: readonly HarmonizerCell[],
  model: string,
  checks: readonly HarmonyCheck<unknown>[] = CHECKS,
): PlannedRun {
  const plans: PlannedRun["plans"] = []
  const questions: Record<string, HarmonizerQuestion> = {}
  checks.forEach((check, i) => {
    const plan = check.plan(cells)
    if (plan === null) return
    const prefix = prefixFor(i)
    plans.push({ check, plan, prefix })
    Object.assign(questions, check.questions(plan, prefix))
  })
  if (Object.keys(questions).length === 0) return { request: null, plans: [] }
  return {
    request: {
      model,
      state: {
        cells: cells.map((c, index) => ({
          index,
          ...(c.ref ? { ref: c.ref } : {}),
          source: c.source,
          target: c.target,
        })),
      },
      questions,
    },
    plans,
  }
}

/** Findings from a Jev response. Missing or malformed answers yield nothing for
 *  that check — a partial response never becomes a wrong suggestion. */
export function harmonizerFindings(
  run: PlannedRun,
  cells: readonly HarmonizerCell[],
  body: unknown,
): HarmonizerFinding[] {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers
  if (!answers || typeof answers !== "object") return []
  return run.plans.flatMap(({ check, plan, prefix }) => check.findings(plan, cells, answers, prefix))
}
