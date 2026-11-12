/**
 * team-handoffs.ts — durable store for human-expert handoffs on the shared
 * team channel (AQU-1052).
 *
 * The channel (lib/team-channel.ts) records the agent narrating and the
 * humans talking back. A handoff is the ask that runs the other way: a
 * contributor hits a question only a human expert can settle, parks whatever
 * agent work depended on it, and needs the question, the answer and the
 * resume to still be there months later.
 *
 * Lives beside the channel rather than in db/shared/ because raising a
 * handoff IS a channel write: it opens the `human` thread the ask is
 * discussed in and posts the question into the main channel, and splitting
 * those two halves across modules would let a handoff exist with no thread.
 *
 * What is NOT here, on purpose:
 *
 *   • No sweep. `contextual_decisions` expires and supersedes, because a
 *     deterministic readiness check can close the gap the agent asked about.
 *     Nothing deterministic can close a question addressed to a person.
 *   • No resume of the dependent run. Answering records the answer; a person
 *     then resumes the work explicitly (routes/team.ts). A handoff is raised
 *     BY a person about work they parked, and "stop, this file is wrong" is
 *     a perfectly good answer — so resuming cannot ride on answering.
 */

import type { AquillaDb } from "../../../db/shim/postgres"
import {
  TEAM_HANDOFF_ANSWER_MAX,
  TEAM_HANDOFF_LIST_DEFAULT,
  TEAM_HANDOFF_LIST_MAX,
  TEAM_HANDOFF_QUESTION_MAX,
  type TeamHandoff,
  type TeamHandoffAnswerBody,
  type TeamHandoffAskedBody,
  type TeamHandoffStatus,
} from "../../../shared/team-handoffs"
import {
  TEAM_THREAD_TITLE_MAX,
  type TeamMessage,
  type TeamThread,
} from "../../../shared/team-channel"
import { appendMessage, ensureThread, touchThread } from "./team-channel"

// ── Row mapping ─────────────────────────────────────────────────────────────

interface HandoffRow {
  id: string
  project_id: string
  thread_id: string
  question: string
  requested_by: string
  run_id: string | null
  status: TeamHandoffStatus
  assigned_to: string | null
  assigned_by: string | null
  assigned_at: unknown
  answer: string | null
  answered_by: string | null
  answered_at: unknown
  resumed_by: string | null
  resumed_at: unknown
  created_at: unknown
  updated_at: unknown
}

const HANDOFF_COLS = `id, project_id, thread_id, question, requested_by, run_id,
  status, assigned_to, assigned_by, assigned_at, answer, answered_by,
  answered_at, resumed_by, resumed_at, created_at, updated_at`

/** postgres.js hands timestamptz back as a string, PGlite as a Date; both
 *  reach the wire as one ISO string. Mirrors `toIso` in team-channel.ts. */
function toIso(value: unknown): string {
  if (value == null) return ""
  if (value instanceof Date) return value.toISOString()
  return new Date(value as string).toISOString()
}

function toIsoOrNull(value: unknown): string | null {
  return value == null ? null : toIso(value)
}

export function handoffDto(row: HandoffRow): TeamHandoff {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    question: row.question,
    requestedBy: row.requested_by,
    requestedAt: toIso(row.created_at),
    runId: row.run_id,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedBy: row.assigned_by,
    assignedAt: toIsoOrNull(row.assigned_at),
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: toIsoOrNull(row.answered_at),
    resumedBy: row.resumed_by,
    resumedAt: toIsoOrNull(row.resumed_at),
    updatedAt: toIso(row.updated_at),
  }
}

/** The thread's title is the ask itself, clipped to what the column holds.
 *  An ellipsis marks the clip so nobody reads a truncated question as the
 *  whole question. */
export function handoffThreadTitle(question: string): string {
  const oneLine = question.trim().replace(/\s+/g, " ")
  // Clip by CODE POINT, not by UTF-16 unit: the column's CHECK counts code
  // points, and slicing mid-surrogate would hand Postgres a lone surrogate
  // that has no UTF-8 encoding at all.
  const points = Array.from(oneLine)
  return points.length <= TEAM_THREAD_TITLE_MAX
    ? oneLine
    : `${points.slice(0, TEAM_THREAD_TITLE_MAX - 1).join("")}…`
}

// ── Raise ───────────────────────────────────────────────────────────────────

export interface RaiseHandoffInput {
  /** Caller-supplied for retry idempotency; generated when absent. The thread
   *  is found-or-created from it, so a retry that gets this far reuses the
   *  thread rather than opening a second one. */
  id?: string
  projectId: string
  /** Username of the asker — the authenticated session, never a request body. */
  requestedBy: string
  question: string
  /** The contextual run this ask blocks, if any. */
  runId?: string | null
}

export interface RaisedHandoff {
  handoff: TeamHandoff
  thread: TeamThread
  /** The main-channel message that owns the thread. */
  message: TeamMessage
}

/**
 * Open a handoff: a `human` thread for the conversation, the row that carries
 * its state, and the main-channel question that owns the thread.
 *
 * Write order matters. The thread comes first because the row references it;
 * the main-channel message comes last because it is the thing people see, and
 * a message pointing at a thread that failed to get a handoff would be a lie
 * on a shared history. The length guards run before any of it.
 *
 * A handoff is always raised UNASSIGNED. Routing it at the same moment is the
 * caller's follow-up `assignHandoff` call, so there is exactly one code path
 * that writes an assignment and exactly one that records who made it.
 */
export async function raiseHandoff(
  db: AquillaDb,
  input: RaiseHandoffInput,
): Promise<RaisedHandoff> {
  const question = input.question.trim()
  if (!question) throw new Error("question is required")
  if (question.length > TEAM_HANDOFF_QUESTION_MAX) {
    throw new Error(`question exceeds ${TEAM_HANDOFF_QUESTION_MAX} characters`)
  }

  const id = input.id ?? crypto.randomUUID()
  const { thread } = await ensureThread(db, {
    projectId: input.projectId,
    sourceKind: "human",
    sourceRef: id,
    title: handoffThreadTitle(question),
  })

  const row = await db
    .prepare(
      `INSERT INTO team_handoffs
         (id, project_id, thread_id, question, requested_by, run_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${HANDOFF_COLS}`,
    )
    .bind(
      id,
      input.projectId,
      thread.id,
      question,
      input.requestedBy,
      input.runId ?? null,
    )
    .first<HandoffRow>()
  if (!row) throw new Error("failed to raise handoff")

  const body: TeamHandoffAskedBody = {
    kind: "handoffAsked",
    handoffId: id,
    threadId: thread.id,
    question,
    runId: input.runId ?? null,
  }
  const message = await appendMessage(db, {
    projectId: input.projectId,
    threadId: null,
    author: { kind: "human", id: input.requestedBy },
    bodyKind: "question",
    body,
  })
  return { handoff: handoffDto(row), thread, message }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getHandoff(
  db: AquillaDb,
  handoffId: string,
): Promise<TeamHandoff | null> {
  const row = await db
    .prepare(`SELECT ${HANDOFF_COLS} FROM team_handoffs WHERE id = ?`)
    .bind(handoffId)
    .first<HandoffRow>()
  return row ? handoffDto(row) : null
}

export interface ListHandoffsInput {
  projectId: string
  /** `true` narrows to what the team is still waiting on a person for. */
  openOnly?: boolean
  limit?: number
}

/** The project's handoffs, newest first — the order the surface reads them
 *  in, and the order that puts today's unanswered ask at the top. */
export async function listHandoffs(
  db: AquillaDb,
  input: ListHandoffsInput,
): Promise<TeamHandoff[]> {
  const limit = Math.max(
    1,
    Math.min(TEAM_HANDOFF_LIST_MAX, Math.floor(input.limit ?? TEAM_HANDOFF_LIST_DEFAULT)),
  )
  const { results } = await db
    .prepare(
      `SELECT ${HANDOFF_COLS} FROM team_handoffs
        WHERE project_id = ? ${input.openOnly ? "AND status = 'open'" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(input.projectId, limit)
    .all<HandoffRow>()
  return (results ?? []).map(handoffDto)
}

// ── Transitions ─────────────────────────────────────────────────────────────

export type HandoffTransition =
  | { status: "ok"; handoff: TeamHandoff }
  | { status: "invalid_state" }
  | { status: "not_found" }

/** Every transition is a GUARDED UPDATE whose WHERE clause names the state it
 *  may move from, so two racing writers cannot both win: the loser matches
 *  zero rows, and one follow-up read tells "wrong state" from "no such row".
 *  Same shape as db/shared/contextual-decisions.ts. */
async function transition(
  db: AquillaDb,
  id: string,
  sql: string,
  binds: unknown[],
): Promise<HandoffTransition> {
  const row = await db.prepare(sql).bind(...binds).first<HandoffRow>()
  if (row) return { status: "ok", handoff: handoffDto(row) }
  const exists = await db
    .prepare("SELECT 1 AS n FROM team_handoffs WHERE id = ?")
    .bind(id)
    .first<{ n: number }>()
  return exists ? { status: "invalid_state" } : { status: "not_found" }
}

/** Routing is an ASSIGNMENT: the handoff stays `open`, and anyone with the
 *  knowledge may still answer it. Re-assigning an already-routed handoff is
 *  allowed and overwrites — people hand questions on. */
export async function assignHandoff(
  db: AquillaDb,
  id: string,
  assignedTo: string,
  byUsername: string,
): Promise<HandoffTransition> {
  return transition(
    db,
    id,
    `UPDATE team_handoffs
        SET assigned_to = ?, assigned_by = ?, assigned_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE id = ? AND status = 'open'
      RETURNING ${HANDOFF_COLS}`,
    [assignedTo, byUsername, id],
  )
}

/**
 * Record the accountable answer. Deliberately does not touch the dependent
 * run: see the module header.
 *
 * The answer is also posted into the handoff's thread, as the answering
 * person speaking, so the shared history reads as a conversation rather than
 * as a row that quietly changed.
 */
export async function answerHandoff(
  db: AquillaDb,
  id: string,
  answer: string,
  byUsername: string,
): Promise<HandoffTransition> {
  const trimmed = answer.trim()
  if (!trimmed) throw new Error("answer is required")
  if (trimmed.length > TEAM_HANDOFF_ANSWER_MAX) {
    throw new Error(`answer exceeds ${TEAM_HANDOFF_ANSWER_MAX} characters`)
  }
  const result = await transition(
    db,
    id,
    `UPDATE team_handoffs
        SET status = 'answered', answer = ?, answered_by = ?,
            answered_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ? AND status = 'open'
      RETURNING ${HANDOFF_COLS}`,
    [trimmed, byUsername, id],
  )
  if (result.status !== "ok") return result

  const body: TeamHandoffAnswerBody = { text: trimmed, handoffId: id }
  await appendMessage(db, {
    projectId: result.handoff.projectId,
    threadId: result.handoff.threadId,
    author: { kind: "human", id: byUsername },
    bodyKind: "text",
    body,
  })
  await touchThread(db, result.handoff.threadId)
  return result
}

/** Record that a person explicitly put the dependent work back to work. The
 *  guard is the invariant the table also carries: only an answered handoff
 *  with a run, and only once. */
export async function markHandoffResumed(
  db: AquillaDb,
  id: string,
  byUsername: string,
): Promise<HandoffTransition> {
  return transition(
    db,
    id,
    `UPDATE team_handoffs
        SET resumed_by = ?, resumed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE id = ? AND status = 'answered' AND run_id IS NOT NULL
        AND resumed_at IS NULL
      RETURNING ${HANDOFF_COLS}`,
    [byUsername, id],
  )
}
