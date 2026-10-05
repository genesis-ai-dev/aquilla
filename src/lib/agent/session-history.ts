/**
 * session-history.ts — typed client for Team chat history (AQU-1653).
 *
 * Mirrors src/lib/agent/memory-api.ts conventions: AUTH_BASE +
 * fetchWithTimeout + `Authorization: Bearer <jwt>`, a thrown Error subclass on
 * a non-OK response.
 *
 * WHAT A REOPENED CHAT IS. The server stores the MODEL's conversation
 * (user/assistant/tool), not the dock's run timeline — so reopening a chat
 * restores the conversation, not the live run chrome. Tool chips, proposal
 * cards and budget meters belonged to the run that was streaming at the time;
 * they are not resurrected, and the restored runs are marked so the UI can say
 * as much. Nothing is lost for the model: the server still holds this
 * session's full convo including tool results, so the next turn sent under the
 * same session id resumes with everything the earlier runs discovered.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import type { AgentRunUi } from "./run-state"

/** One row of the chat switcher. */
export interface AgentSessionSummary {
  sessionId: string
  /** `''` when the chat has no user turn yet — render a placeholder. */
  title: string
  createdAt: number
  updatedAt: number
}

export interface SessionTurn {
  role: "user" | "assistant"
  text: string
}

export interface AgentSessionTranscript extends AgentSessionSummary {
  turns: SessionTurn[]
}

export class SessionHistoryError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

async function failed(res: Response, fallback: string): Promise<never> {
  let body: ErrorEnvelope | null = null
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    /* non-JSON error body — fall through to the generic message */
  }
  const message = body?.error?.message ?? fallback
  throw new SessionHistoryError(`${fallback}: HTTP ${res.status} — ${message}`, res.status)
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

/** GET /api/v2/projects/:projectId/agent-sessions — the caller's own chats,
 *  newest first. */
export async function listAgentSessions(
  jwt: string,
  projectId: string,
): Promise<AgentSessionSummary[]> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-sessions`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return failed(res, "list chats failed")
  return ((await res.json()) as { sessions: AgentSessionSummary[] }).sessions ?? []
}

/** GET /api/v2/projects/:projectId/agent-sessions/:sessionId — one of the
 *  caller's own chats. A 404 covers "no such chat" and "not yours" alike. */
export async function fetchAgentSession(
  jwt: string,
  projectId: string,
  sessionId: string,
): Promise<AgentSessionTranscript> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return failed(res, "open chat failed")
  return ((await res.json()) as { session: AgentSessionTranscript }).session
}

/**
 * Turns → the dock's run timeline.
 *
 * One run per user turn, carrying the assistant prose that answered it. A
 * trailing assistant turn with no user turn before it (the autopilot writing
 * into the channel, or a transcript compaction that cut the opening exchange)
 * becomes a run with an empty prompt rather than being dropped — losing the
 * model's reply would misrepresent the conversation.
 *
 * `restored: true` marks every run so the view can label the chat as reopened
 * and skip affordances that only make sense live (Apply on a proposal whose
 * changeset is long gone, "use this file" buttons for a question already
 * answered).
 */
export function runsFromTurns(turns: readonly SessionTurn[]): AgentRunUi[] {
  const runs: AgentRunUi[] = []
  for (const turn of turns) {
    if (turn.role === "user") {
      runs.push({
        localId: `restored-${runs.length}`,
        prompt: turn.text,
        wireContent: turn.text,
        runId: null,
        items: [],
        status: "ok",
        restored: true,
      })
      continue
    }
    const open = runs[runs.length - 1]
    const item = { id: "i0", kind: "text" as const, text: turn.text }
    if (!open || open.items.length > 0) {
      runs.push({
        localId: `restored-${runs.length}`,
        prompt: "",
        wireContent: "",
        runId: null,
        items: [item],
        status: "ok",
        restored: true,
      })
      continue
    }
    runs[runs.length - 1] = { ...open, items: [item] }
  }
  return runs
}
