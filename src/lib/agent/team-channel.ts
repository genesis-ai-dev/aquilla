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
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { personaForRegion, type AgentPersonaId } from "./personas"
import type { TeamFeedMessage } from "./social-feed"

/** The plain-language sentence for one feed step — shared by the thread pane
 *  and the step inspector so the two can never disagree. */
export function feedMessageText(message: TeamFeedMessage, t: TFunction): string {
  const span = (label: string | null) => label ?? t("agent.team.spanFallback")
  const { body } = message
  switch (body.kind) {
    case "started":
      return t("agent.team.msg.started", { span: span(body.spanLabel) })
    case "phase":
      if (body.region === "reading") return t("agent.team.msg.reading", { span: span(body.spanLabel) })
      if (body.region === "drafting") return t("agent.team.msg.drafting", { span: span(body.spanLabel) })
      if (body.region === "checking") return t("agent.team.msg.checking", { span: span(body.spanLabel) })
      // buildRunFeed never emits staging phases; keep the mapping total anyway.
      return t("agent.team.msg.outcomeDone", { span: span(body.spanLabel) })
    case "sceneReady":
      return body.ambiguityCount != null && body.ambiguityCount > 0
        ? t("agent.team.msg.sceneReady", {
            span: span(body.spanLabel),
            count: body.ambiguityCount,
          })
        : t("agent.team.msg.sceneReadyUncounted", { span: span(body.spanLabel) })
    case "draftsStaged":
      return body.count != null
        ? t("agent.team.msg.draftsStaged", { count: body.count })
        : t("agent.team.msg.draftsStagedUncounted")
    case "outcome":
      if (body.status === "done") return t("agent.team.msg.outcomeDone", { span: span(body.spanLabel) })
      if (body.status === "partial") return t("agent.team.msg.outcomePartial", { span: span(body.spanLabel) })
      return t("agent.team.msg.outcomeFailed", { span: span(body.spanLabel) })
  }
}

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

// ── Conversation selection (v2.1 "typical chat" layout) ─────────────────────
//
// The Team tab is a conversations LIST beside one ACTIVE conversation. Two
// conversations are fixed: the main team chat (the orchestrator) and, while
// open questions exist, a single "needs your expertise" conversation holding
// every DecisionCard — one place to answer, not a thread per question. Every
// autopilot run is its own conversation, addressed by `runThreadId`.

export const TEAM_CHAT_CONVERSATION = "team-chat"
export const QUESTIONS_CONVERSATION = "questions"

/** Query param carrying the active conversation on `/project/:id/agent` —
 *  URL-driven so the sidebar list and the center pane share one selection
 *  (and a thread can be linked to). Absent = Team chat. */
export const CONVERSATION_PARAM = "conversation"

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
