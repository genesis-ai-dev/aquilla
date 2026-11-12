/**
 * team-handoffs.ts — wire shapes for human-expert handoffs on the shared team
 * channel (AQU-1052; the ask that runs the other way from the agent → human
 * decision channel in db/shared/contextual-decisions.ts).
 *
 * Types only, no zod: auth-worker pins zod 3 and the SPA pins zod 4, so a
 * schema declared here would have to pick one and break the other — the same
 * reason shared/team-channel.ts carries none. Request validation lives next
 * to the router (auth-worker/src/routes/team.ts).
 *
 * A handoff is four facts, each with its actor and its time, because the
 * record has to answer "who asked, who answered, and did the work carry on?"
 * for a lead who was not in the room:
 *
 *   request    `question` + `requestedBy` + `requestedAt`
 *   assignment `assignedTo` + `assignedBy` + `assignedAt`
 *   answer     `answer` + `answeredBy` + `answeredAt`
 *   resume     `resumedBy` + `resumedAt`
 *
 * Actors are usernames — the team channel's own vocabulary
 * (`TeamMessageAuthor` for a human) — so a handoff renders beside messages
 * written by the same people without a join per name.
 */

/** `answered` means exactly "has an accountable answer". There is no
 *  `expired`/`superseded`: nothing deterministic can close a question
 *  addressed to a human, so it stays open until somebody answers it. */
export type TeamHandoffStatus = "open" | "answered"

export interface TeamHandoff {
  id: string
  projectId: string
  /** The `human` thread the ask is discussed in. */
  threadId: string
  question: string
  /** Username of the contributor who asked. */
  requestedBy: string
  requestedAt: string
  /** The contextual run blocked on this ask; null for a standalone question. */
  runId: string | null
  status: TeamHandoffStatus
  /** Routing only ASSIGNS: an assigned handoff is still `open`, and anyone
   *  with the knowledge may answer it. */
  assignedTo: string | null
  assignedBy: string | null
  assignedAt: string | null
  answer: string | null
  answeredBy: string | null
  answeredAt: string | null
  /** Dependent work resumes only when a person says so, after the answer —
   *  "stop, this file is wrong" is a valid answer to a handoff. */
  resumedBy: string | null
  resumedAt: string | null
  updatedAt: string
}

/**
 * The main-channel message that opens a handoff and owns its thread. Carried
 * on `bodyKind: "question"`, which the channel already has for exactly this —
 * a message the team is waiting on an answer to.
 *
 * Deliberately NOT a member of `TeamActivityBody`: that union mirrors
 * src/lib/agent/social-feed.ts message for message, and a handoff has no
 * counterpart there.
 *
 * Declared as a `type`, not an `interface`, so it is assignable to the
 * `Record<string, unknown>` body parameter of `appendMessage` — only type
 * aliases get the implicit index signature that assignment needs.
 */
export type TeamHandoffAskedBody = {
  kind: "handoffAsked"
  handoffId: string
  /** The thread the ask opens. Mirrors `TeamTextBody.threadId`, which is what
   *  makes a main-channel message the owner of a thread. */
  threadId: string
  question: string
  runId: string | null
}

/** The answer, posted into the handoff's thread as the answering person
 *  speaking — because that is what it is. `bodyKind: "text"`, so any channel
 *  renderer shows it as plain talk; `handoffId` is the breadcrumb back to the
 *  record. */
export type TeamHandoffAnswerBody = {
  text: string
  handoffId: string
}

/** Ceiling on the ask and on the answer, in characters. Matches
 *  `DECISION_REASON_MAX_BYTES` / `DECISION_ANSWER_MAX_BYTES` next door: these
 *  are questions and answers, not documents. */
export const TEAM_HANDOFF_QUESTION_MAX = 2000
export const TEAM_HANDOFF_ANSWER_MAX = 2000

/** Ceiling on one page of the project's handoff list. */
export const TEAM_HANDOFF_LIST_MAX = 100
export const TEAM_HANDOFF_LIST_DEFAULT = 50
