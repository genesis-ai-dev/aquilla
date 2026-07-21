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
  const title = firstUserText(session.convo).slice(0, 120)
  const now = Date.now()
  await db
    .prepare(
      `INSERT INTO agent_sessions (session_id, project_id, user_id, title, convo, untrusted_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         convo = EXCLUDED.convo,
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
