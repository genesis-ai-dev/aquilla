// Raise a question whose answer becomes a durable project fact (AQU-1691).
//
// A fact question is raised with runId: null, so it never parks a run: the
// trust gate in ./tick.ts parks only on a run's OWN open decision. Autopilot
// keeps drafting with the facts it already has, and once someone answers, the
// fact reaches every later draft through loadProjectContext — in any run and
// any file (db/shared/contextual-decision-lifecycle.ts writes it).
//
// Raising one also closes the questions it makes stale: an older open
// question for the same key is superseded (./supersede.ts, fact branch). A
// key the project has already decided is not asked again.

import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  decisionOptionsProblem,
  listOpenFactQuestions,
  raiseDecision,
  supersedeDecisions,
  type ContextualDecision,
  type DecisionOption,
} from "../../../../db/shared/contextual-decisions"
import {
  decidedFactKeys,
  factAnswerProblem,
  factKeyProblem,
  factScopeProblem,
  readProjectFacts,
  type FactScope,
} from "../../../../db/shared/project-facts"
import { readSettingsBlob } from "../../../../db/shared/project-facts-write"
import { isFactQuestionSuperseded } from "./supersede"

export interface RaiseFactQuestionInput {
  projectId: string
  factKey: string
  /** WHY the question matters, in the user's words, like any decision reason. */
  reason: string
  options?: DecisionOption[]
  factScope?: FactScope
  /** Where the question came from, for the card's "where" line. */
  fileId?: string | null
  spanId?: string | null
  cellIds?: string[]
  blastRadius?: number
}

export type FactQuestionProblem = "invalid-key" | "invalid-scope" | "invalid-options" | "option-not-storable"

export type RaiseFactQuestionResult =
  | { status: "raised"; decision: ContextualDecision; superseded: number }
  | { status: "already_decided" }
  | { status: "invalid"; reason: FactQuestionProblem }

async function raiseIn(tx: AquillaDb, input: RaiseFactQuestionInput): Promise<RaiseFactQuestionResult> {
  const settings = await readSettingsBlob(tx, input.projectId)
  const decided = decidedFactKeys(readProjectFacts(settings.projectFacts), settings.languageProfile)
  if (decided.has(input.factKey)) return { status: "already_decided" }
  // An option the fact could not hold would turn a one-click answer into an error.
  if (input.options?.some((option) => factAnswerProblem(input.factKey, option.value, settings.languageProfile))) {
    return { status: "invalid", reason: "option-not-storable" }
  }
  const decision = await raiseDecision(tx, {
    projectId: input.projectId,
    runId: null,
    fileId: input.fileId ?? null,
    spanId: input.spanId ?? null,
    cellIds: input.cellIds ?? [],
    reason: input.reason,
    readinessItem: "bible-fact",
    factKey: input.factKey,
    options: input.options ?? null,
    factScope: input.factScope ?? null,
    blastRadius: input.blastRadius ?? 0,
  })
  const open = await listOpenFactQuestions(tx, { projectId: input.projectId, factKey: input.factKey })
  const snapshot = {
    decidedFactKeys: decided,
    // The question just raised is the newest by definition.
    newestOpenFactQuestion: new Map([[input.factKey, decision.id]]),
  }
  const stale = open.filter((question) => isFactQuestionSuperseded(question, snapshot))
  const superseded = await supersedeDecisions(tx, stale.map((question) => question.id))
  return { status: "raised", decision, superseded }
}

export async function raiseFactQuestion(
  db: AquillaDb,
  input: RaiseFactQuestionInput,
): Promise<RaiseFactQuestionResult> {
  if (factKeyProblem(input.factKey)) return { status: "invalid", reason: "invalid-key" }
  if (input.factScope && factScopeProblem(input.factScope)) return { status: "invalid", reason: "invalid-scope" }
  if (input.options && decisionOptionsProblem(input.options)) return { status: "invalid", reason: "invalid-options" }
  return db.transaction ? db.transaction((tx) => raiseIn(tx, input)) : raiseIn(db, input)
}
