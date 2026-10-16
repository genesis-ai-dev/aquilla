// agent_sessions — server-persisted agent conversations (design 2026-07-02 §2.3).
//
// One row per (client-generated) session id. The stored convo is the model
// conversation MINUS the system prompt (rebuilt fresh every run — focus,
// settings, and role can change between turns) — user turns, assistant turns
// (including tool_calls), and tool results. Keeping tool results is the whole
// point: a follow-up run reuses what the last run discovered instead of
// re-querying the project from scratch.
//
// Table: db/postgres/schema.sql + db/postgres/migrations/0050_agent_sessions.sql.

import type { ToolCall } from "./upstream"

/** A stored conversation message — everything except the system prompt. */
export type StoredMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface AgentSession {
  sessionId: string
  projectId: string
  userId: number
  convo: StoredMessage[]
  /**
   * True when the run that last saved this session ended with untrusted content
   * still in scope (a tool touched untrusted artifact bytes and no later clean
   * turn cleared it). The next run on this session initialises its
   * untrusted-content guard from this flag so memory writes stay locked across
   * runs (adversarial-panel authz-M2 / races-F2). Defaults to false.
   */
  untrustedActive?: boolean
}

export async function loadSession(db: AquillaDb, sessionId: string): Promise<AgentSession | null> {
  const row = await db
    .prepare(
      "SELECT session_id, project_id, user_id, convo, untrusted_active FROM agent_sessions WHERE session_id = ?",
    )
    .bind(sessionId)
    .first<{
      session_id: string
      project_id: string
      user_id: number
      convo: string
      untrusted_active: boolean | null
    }>()
  if (!row) return null
  let convo: StoredMessage[] = []
  try {
    const parsed = JSON.parse(row.convo) as unknown
    if (Array.isArray(parsed)) convo = parsed as StoredMessage[]
  } catch {
    /* corrupt convo degrades to a fresh session — never fails the run */
  }
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    userId: Number(row.user_id),
    convo,
    untrustedActive: row.untrusted_active === true,
  }
}

/** Upsert the session with its post-run conversation (already compacted). */
export async function saveSession(db: AquillaDb, session: AgentSession): Promise<void> {
  const title = deriveSessionTitle(session.convo)
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO agent_sessions (session_id, project_id, user_id, title, convo, untrusted_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         convo = EXCLUDED.convo,
         -- AQU-1653: the chat list shows this title, so a session whose FIRST
         -- save carried no user turn must not stay nameless forever. A title
         -- already on the row is never overwritten (it is what the user has
         -- been seeing); an empty one is filled the moment a user turn exists.
         title = CASE
           WHEN COALESCE(agent_sessions.title, '') = '' THEN EXCLUDED.title
           ELSE agent_sessions.title
         END,
         untrusted_active = EXCLUDED.untrusted_active,
         updated_at = EXCLUDED.updated_at`,
    )
    .bind(
      session.sessionId,
      session.projectId,
      session.userId,
      title,
      JSON.stringify(session.convo),
      session.untrustedActive ?? false,
      now,
      now,
    )
    .run()
}

function firstUserText(convo: StoredMessage[]): string {
  const first = convo.find((m) => m.role === "user")
  return first && typeof first.content === "string" ? first.content : ""
}

/**
 * AQU-1653: the name a chat is listed under — the first thing the user said,
 * capped. Derived rather than stored-only so a row saved before the title
 * backfill (or one whose first save carried no user turn) still reads sensibly
 * when the single-session route has the convo in hand. Empty when the
 * conversation has no user turn yet; callers render their own placeholder
 * rather than inventing one here, so the wording stays translatable.
 */
export function deriveSessionTitle(convo: StoredMessage[]): string {
  return firstUserText(convo).slice(0, 120)
}

/** One row of the caller's chat list. */
export interface AgentSessionSummary {
  sessionId: string
  /** `''` when the conversation has no user turn yet. */
  title: string
  createdAt: number
  updatedAt: number
}

/** A readable turn of a past chat. Tool traffic is not a turn. */
export interface SessionTurn {
  role: "user" | "assistant"
  text: string
}

/** A past chat in the form the client renders. */
export interface AgentSessionTranscript extends AgentSessionSummary {
  turns: SessionTurn[]
}

/**
 * The readable transcript of a stored conversation.
 *
 * `convo` is the MODEL's view: user turns, assistant turns (some carrying only
 * `tool_calls`), and tool results. Only the prose is a turn a person reads
 * back — tool results are the agent's working notes, were never rendered as
 * messages, and (post-compaction) are digests rather than what the user saw.
 * Consecutive assistant prose is joined the way a live run renders it, so one
 * reply that was interrupted by tool calls reads as one reply.
 *
 * Reopening a chat therefore restores the CONVERSATION, not the live run
 * chrome (tool chips, proposal cards). Continuing it loses nothing: the server
 * still holds this session's full `convo`, tool results included, so the next
 * turn resumes with everything the earlier runs discovered.
 */
export function transcriptTurns(convo: StoredMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = []
  for (const message of convo) {
    if (message.role === "tool") continue
    const text = typeof message.content === "string" ? message.content.trim() : ""
    if (text === "") continue
    const last = turns[turns.length - 1]
    if (message.role === "assistant" && last?.role === "assistant") {
      last.text = `${last.text}\n\n${text}`
      continue
    }
    turns.push({ role: message.role, text })
  }
  return turns
}

/**
 * The caller's OWN chats on one project, newest first. Scoped to
 * `(project_id, user_id)` so one member never lists another's conversations,
 * and selected without `convo` so the list stays cheap on the
 * `(project_id, user_id, updated_at DESC)` index — a session's convo can run
 * to a hundred messages, and the list only needs its name.
 */
export async function listSessionsForUser(
  db: AquillaDb,
  projectId: string,
  userId: number,
  limit = 50,
): Promise<AgentSessionSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT session_id, title, created_at, updated_at
         FROM agent_sessions
        WHERE project_id = ? AND user_id = ?
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .bind(projectId, userId, limit)
    .all<{
      session_id: string
      title: string | null
      created_at: number | string
      updated_at: number | string
    }>()
  return (results ?? []).map((row) => ({
    sessionId: row.session_id,
    title: row.title ?? "",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}

/**
 * One of the caller's own chats, as a readable transcript.
 *
 * Returns null both when no such session exists and when it belongs to someone
 * else or another project — a caller must not be able to tell those apart, so
 * the route maps either to the same 404 (same rule as the lane read wall).
 */
export async function loadSessionForUser(
  db: AquillaDb,
  projectId: string,
  userId: number,
  sessionId: string,
): Promise<AgentSessionTranscript | null> {
  const row = await db
    .prepare(
      `SELECT session_id, title, convo, created_at, updated_at
         FROM agent_sessions
        WHERE session_id = ? AND project_id = ? AND user_id = ?`,
    )
    .bind(sessionId, projectId, userId)
    .first<{
      session_id: string
      title: string | null
      convo: string
      created_at: number | string
      updated_at: number | string
    }>()
  if (!row) return null
  let convo: StoredMessage[] = []
  try {
    const parsed = JSON.parse(row.convo) as unknown
    if (Array.isArray(parsed)) convo = parsed as StoredMessage[]
  } catch {
    /* corrupt convo reads as an empty chat — never fails the request */
  }
  const stored = (row.title ?? "").trim()
  return {
    sessionId: row.session_id,
    title: stored === "" ? deriveSessionTitle(convo) : stored,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    turns: transcriptTurns(convo),
  }
}

// ── Compaction ──────────────────────────────────────────────────────────────
// Old tool results are the bulk of a conversation; their full text only
// matters while the model is actively working that turn. Keep the last
// KEEP_FULL_USER_TURNS turns verbatim, truncate older tool contents to a
// digest, and cap total stored messages (dropped from the front at a user-turn
// boundary so the transcript never starts mid-exchange).

const KEEP_FULL_USER_TURNS = 2
const COMPACTED_TOOL_MAX = 400
const MAX_STORED_MESSAGES = 120

export function compactConvo(convo: StoredMessage[]): StoredMessage[] {
  // Index of the user message that starts the "keep verbatim" window.
  let userSeen = 0
  let keepFrom = 0
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i].role === "user") {
      userSeen++
      if (userSeen >= KEEP_FULL_USER_TURNS) {
        keepFrom = i
        break
      }
    }
  }

  let out = convo.map((m, i) => {
    if (i >= keepFrom || m.role !== "tool") return m
    if (m.content.length <= COMPACTED_TOOL_MAX) return m
    return { ...m, content: `${m.content.slice(0, COMPACTED_TOOL_MAX)}\n…[compacted]` }
  })

  if (out.length > MAX_STORED_MESSAGES) {
    let start = out.length - MAX_STORED_MESSAGES
    // Advance to the next user turn so the kept transcript starts cleanly.
    while (start < out.length && out[start].role !== "user") start++
    out = out.slice(start)
  }
  return out
}
