// Atomic Decision → steering/cursor → run lifecycle bridge (AQU-974).
//
// The decision routes and the tick deliberately share this function. A human
// answer must not close its card while leaving the run stranded in `waiting`;
// PostgresDb.transaction makes the resolution, steering write, cursor change,
// and unblock one commit. Lightweight test doubles without transaction()
// retain the same call order, but production and PGlite tests are atomic.

import type { AquillaDb } from "../shim/postgres"
import {
  answerDecision,
  dismissDecision,
  getDecision,
  type ContextualDecision,
  type DecisionTransition,
} from "./contextual-decisions"
import {
  appendSteering,
  getRun,
  grantSpanAllowance,
  setSpanCursor,
  unblockRun,
  INPUT_GRANT_CAP,
  INPUT_GRANT_SPANS,
  type ContextualRun,
  type SpanCursor,
} from "./contextual-runs"

export type ResolveBlockingDecisionInput =
  | {
      decisionId: string
      action: "answer"
      answer: string
      byUserId: number
      byUsername: string
    }
  | {
      decisionId: string
      action: "dismiss"
      byUsername: string
    }

export type BlockingDecisionTransition =
  | { status: "ok"; decision: ContextualDecision; run?: ContextualRun }
  | { status: "invalid_state" }
  | { status: "not_found" }

function withoutQueuedRetry(cursor: SpanCursor, spanId: string): SpanCursor {
  const prefix = cursor.seeds.slice(0, cursor.nextIndex)
  const queued = cursor.seeds.slice(cursor.nextIndex)
  const retryAt = queued.findIndex((seed) => seed.id === spanId)
  if (retryAt === -1) return cursor
  return {
    seeds: [...prefix, ...queued.slice(0, retryAt), ...queued.slice(retryAt + 1)],
    nextIndex: cursor.nextIndex,
  }
}

async function resolveInTransaction(
  db: AquillaDb,
  input: ResolveBlockingDecisionInput,
): Promise<BlockingDecisionTransition> {
  const existing = await getDecision(db, input.decisionId)
  if (!existing) return { status: "not_found" }

  const transition: DecisionTransition = input.action === "answer"
    ? await answerDecision(db, input.decisionId, input.answer, input.byUserId)
    : await dismissDecision(db, input.decisionId)
  if (transition.status !== "ok") return transition

  if (!existing.runId) return transition
  const blocked = await getRun(db, existing.runId)
  if (
    !blocked ||
    blocked.status !== "waiting" ||
    blocked.blockedOnDecisionId !== existing.id
  ) {
    return transition
  }

  if (input.action === "answer") {
    await appendSteering(db, {
      projectId: existing.projectId,
      fileId: existing.fileId,
      runId: existing.runId,
      kind: "direction",
      body: `Decision: ${existing.reason}\nHuman answer: ${input.answer}`,
      createdBy: input.byUsername,
    })
  } else if (existing.spanId && blocked.spanCursor) {
    const nextCursor = withoutQueuedRetry(blocked.spanCursor, existing.spanId)
    if (nextCursor !== blocked.spanCursor) {
      await setSpanCursor(db, existing.runId, nextCursor)
    }
  }

  // AQU-1300: answering is human input, so it buys a span — inside the same
  // transaction, and BEFORE the unblock. A run unblocked onto a zero allowance
  // would park again on its very next span edge, so the human would answer the
  // question and watch nothing happen. Dismissing earns the same span: the
  // human still engaged with the question, and the run still has to get past
  // the passage that raised it.
  await grantSpanAllowance(db, existing.runId, {
    spans: INPUT_GRANT_SPANS,
    cap: INPUT_GRANT_CAP,
  })

  const unblocked = await unblockRun(db, existing.runId)
  if (unblocked.status !== "ok") {
    // Throw so transaction-capable handles roll the decision transition back.
    throw new Error(`decision resolved but run could not unblock: ${unblocked.status}`)
  }
  return { status: "ok", decision: transition.decision, run: unblocked.run }
}

export async function resolveBlockingDecision(
  db: AquillaDb,
  input: ResolveBlockingDecisionInput,
): Promise<BlockingDecisionTransition> {
  return db.transaction
    ? db.transaction((tx) => resolveInTransaction(tx, input))
    : resolveInTransaction(db, input)
}
