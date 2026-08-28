/**
 * team-channel.ts — the one-channel model behind the workbench Team tab
 * (v2 of the 2026-08-28 social-workspace design).
 *
 * v1 showed a Slack-style thread list. v2 collapses that into ONE project
 * channel: the Coordinator posts a dispatch message per autopilot run and a
 * question message per decision it can't settle alone, and each of those
 * messages OWNS a thread (the run's play-by-play, or the decision card that
 * answers the question). This module is the pure part of that: transport
 * records in, an ordered channel out, plus the thread-id grammar the channel
 * and the thread pane address each other by.
 *
 * Ordering: runs are time-ordered by `createdAt` ascending, oldest first, so
 * the channel reads top-to-bottom like a chat history. Decisions carry no
 * timestamp on the wire, so open questions land after the dispatches — next
 * to the composer, which is where they get answered.
 */

import { normalizePhase } from "@/lib/contextual/process-graph"
import type {
  ContextualDecisionView,
  ContextualRunRecord,
} from "@/lib/contextual/transport"
import { personaForRegion, type AgentPersonaId } from "./personas"

/** One autopilot run, dispatched by the Coordinator. Owns the run thread. */
export interface TeamDispatchItem {
  kind: "dispatch"
  /** Stable React key and channel-item id. */
  id: string
  threadId: string
  persona: AgentPersonaId
  /** ISO timestamp the run was dispatched. */
  at: string
  run: ContextualRunRecord
}

/** One open question addressed to the human. Owns a decision thread. */
export interface TeamQuestionItem {
  kind: "question"
  id: string
  threadId: string
  persona: AgentPersonaId
  decision: ContextualDecisionView
}

export type TeamChannelItem = TeamDispatchItem | TeamQuestionItem

export function runThreadId(runId: string): string {
  return `run:${runId}`
}

export function decisionThreadId(decisionId: string): string {
  return `decision:${decisionId}`
}

/**
 * Statuses whose thread still accepts a steering message. Parked runs count:
 * waking a parked run on new steering is the server's job, not the client's
 * (see `sendContextualSteering`). Terminal states (`done`/`failed`/
 * `terminated`) have nobody left to read the message.
 */
export function isSteerableStatus(status: string): boolean {
  return (
    status === "running"
    || status === "pausing"
    || status === "paused"
    || status === "parked"
  )
}

/** The teammate currently carrying a run — used for the thread composer's
 *  scope chip so "who am I talking to" is never ambiguous. */
export function personaForRun(run: ContextualRunRecord): AgentPersonaId {
  const region = normalizePhase(run.phase)
  return region ? personaForRegion(region) : "coordinator"
}

export function buildTeamChannel(
  runs: readonly ContextualRunRecord[],
  decisions: readonly ContextualDecisionView[],
): TeamChannelItem[] {
  const dispatches: TeamDispatchItem[] = [...runs]
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.runId.localeCompare(b.runId)
        : a.createdAt.localeCompare(b.createdAt),
    )
    .map((run) => ({
      kind: "dispatch",
      id: runThreadId(run.runId),
      threadId: runThreadId(run.runId),
      persona: "coordinator",
      at: run.createdAt,
      run,
    }))
  const questions: TeamQuestionItem[] = decisions.map((decision) => ({
    kind: "question",
    id: decisionThreadId(decision.id),
    threadId: decisionThreadId(decision.id),
    persona: "coordinator",
    decision,
  }))
  return [...dispatches, ...questions]
}
