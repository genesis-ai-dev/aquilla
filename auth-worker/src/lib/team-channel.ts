/**
 * team-channel.ts — durable store for the shared project channel
 * (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v2).
 *
 * One project-scoped, append-only message history. `thread_id IS NULL` is the
 * main channel — the team overview itself; every delegated piece of work owns
 * a thread hung off a main-channel dispatch message.
 *
 * Ported from the AQU-1049→1052 `team_threads` backend. Divergences from the
 * donor are recorded in db/postgres/migrations/0083_team_channel.sql; the two
 * that shape this module are (a) nullable `thread_id`, and (b) `(created_at,
 * id)` cursors instead of a per-thread `sequence` counter. The counter was
 * allocated under a thread row lock, which the autopilot tick — writing
 * activity outside any request transaction — has no place to take.
 */

import type { AquillaDb } from "../../../db/shim/postgres"
import {
  TEAM_MESSAGE_PAGE_DEFAULT,
  TEAM_MESSAGE_PAGE_MAX,
  type TeamMessage,
  type TeamMessageAuthor,
  type TeamMessageBodyKind,
  type TeamMessagePage,
  type TeamThread,
  type TeamThreadSourceKind,
  type TeamThreadStatus,
} from "../../../shared/team-channel"

// ── Row mapping ─────────────────────────────────────────────────────────────

interface ThreadRow {
  id: string
  project_id: string
  source_kind: TeamThreadSourceKind
  source_ref: string | null
  title: string
  status: TeamThreadStatus
  created_at: unknown
  updated_at: unknown
}

interface MessageRow {
  id: string
  project_id: string
  thread_id: string | null
  author_kind: "human" | "persona"
  author_id: string
  body_kind: TeamMessageBodyKind
  body: unknown
  created_at: unknown
}

const THREAD_COLS = `id, project_id, source_kind, source_ref, title, status,
  created_at, updated_at`
const MESSAGE_COLS = `id, project_id, thread_id, author_kind, author_id,
  body_kind, body, created_at`

function toIso(value: unknown): string {
  if (value == null) return ""
  if (value instanceof Date) return value.toISOString()
  return new Date(value as string).toISOString()
}

/** jsonb crosses the shim as a parsed object under postgres.js and PGlite
 *  alike, but a driver that hands back the raw text must not produce a
 *  message whose body is a string. */
function toBody(value: unknown): Record<string, unknown> {
  let parsed: unknown = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return {}
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export function threadDto(row: ThreadRow): TeamThread {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    title: row.title,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export function messageDto(row: MessageRow): TeamMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    author: { kind: row.author_kind, id: row.author_id } as TeamMessageAuthor,
    bodyKind: row.body_kind,
    body: toBody(row.body),
    createdAt: toIso(row.created_at),
  }
}

// ── Threads ─────────────────────────────────────────────────────────────────

export async function getThread(
  db: AquillaDb,
  projectId: string,
  threadId: string,
): Promise<TeamThread | null> {
  const row = await db
    .prepare(`SELECT ${THREAD_COLS} FROM team_threads WHERE id = ? AND project_id = ?`)
    .bind(threadId, projectId)
    .first<ThreadRow>()
  return row ? threadDto(row) : null
}

export interface EnsureThreadInput {
  projectId: string
  sourceKind: TeamThreadSourceKind
  sourceRef: string
  title: string
}

export interface EnsureThreadResult {
  thread: TeamThread
  /** True only for the caller whose INSERT won. Exactly one caller may then
   *  post the main-channel dispatch message that owns this thread. */
  created: boolean
}

/** Find-or-create the thread for one work item. Two concurrent ticks race
 *  here; the unique (project_id, source_kind, source_ref) constraint picks a
 *  winner and the loser falls through to the SELECT. */
export async function ensureThread(
  db: AquillaDb,
  input: EnsureThreadInput,
): Promise<EnsureThreadResult> {
  const inserted = await db
    .prepare(
      `INSERT INTO team_threads (id, project_id, source_kind, source_ref, title)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, source_kind, source_ref) DO NOTHING
       RETURNING ${THREAD_COLS}`,
    )
    .bind(
      crypto.randomUUID(),
      input.projectId,
      input.sourceKind,
      input.sourceRef,
      input.title,
    )
    .first<ThreadRow>()
  if (inserted) return { thread: threadDto(inserted), created: true }

  const existing = await db
    .prepare(
      `SELECT ${THREAD_COLS} FROM team_threads
        WHERE project_id = ? AND source_kind = ? AND source_ref = ?`,
    )
    .bind(input.projectId, input.sourceKind, input.sourceRef)
    .first<ThreadRow>()
  if (!existing) throw new Error("team thread vanished after conflict")
  return { thread: threadDto(existing), created: false }
}

/** Bump `updated_at` so a channel can order threads by last activity without
 *  aggregating over their messages. */
export async function touchThread(db: AquillaDb, threadId: string): Promise<void> {
  await db
    .prepare("UPDATE team_threads SET updated_at = clock_timestamp() WHERE id = ?")
    .bind(threadId)
    .run()
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface AppendMessageInput {
  /** Caller-supplied for retry idempotency; generated when absent. */
  id?: string
  projectId: string
  /** Omit or null for the main channel. */
  threadId?: string | null
  author: TeamMessageAuthor
  bodyKind: TeamMessageBodyKind
  body: Record<string, unknown>
}

export async function appendMessage(
  db: AquillaDb,
  input: AppendMessageInput,
): Promise<TeamMessage> {
  const row = await db
    .prepare(
      `INSERT INTO team_messages
         (id, project_id, thread_id, author_kind, author_id, body_kind, body)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)
       RETURNING ${MESSAGE_COLS}`,
    )
    .bind(
      input.id ?? crypto.randomUUID(),
      input.projectId,
      input.threadId ?? null,
      input.author.kind,
      input.author.id,
      input.bodyKind,
      // Structured JSON crosses the adapter boundary as an object: `?::jsonb`
      // teaches postgres.js the parameter type and it applies its own JSON
      // serializer. Pre-stringifying would encode the string a second time.
      input.body,
    )
    .first<MessageRow>()
  if (!row) throw new Error("failed to append team message")
  return messageDto(row)
}

export async function getMessage(
  db: AquillaDb,
  projectId: string,
  messageId: string,
): Promise<TeamMessage | null> {
  const row = await db
    .prepare(`SELECT ${MESSAGE_COLS} FROM team_messages WHERE id = ? AND project_id = ?`)
    .bind(messageId, projectId)
    .first<MessageRow>()
  return row ? messageDto(row) : null
}

/** The newest activity message for one span inside a thread. Ingestion uses
 *  this to collapse consecutive same-region phase updates, matching the
 *  client derivation it replaces (src/lib/agent/social-feed.ts). */
export async function latestSpanActivity(
  db: AquillaDb,
  projectId: string,
  threadId: string,
  spanId: string | null,
): Promise<TeamMessage | null> {
  const row = await db
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM team_messages
        WHERE project_id = ? AND thread_id = ? AND body_kind = 'activity'
          AND body ->> 'spanId' IS NOT DISTINCT FROM ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(projectId, threadId, spanId)
    .first<MessageRow>()
  return row ? messageDto(row) : null
}

export interface ReadPageInput {
  projectId: string
  /** `undefined` reads the main channel; a string reads that thread. */
  threadId?: string
  /** Message id — return the page of messages strictly OLDER than it. */
  before?: string
  /** Message id — return messages strictly NEWER than it, oldest first. */
  after?: string
  limit?: number
}

export type ReadPageResult =
  | { status: "ok"; page: TeamMessagePage }
  | { status: "invalid_cursor" }

/** One page of channel history, newest-last.
 *
 *  Cursors are message ids resolved to their `(created_at, id)` position, so
 *  a page can never straddle two rows written in the same microsecond. `id`
 *  is only the tiebreaker; `created_at` (clock_timestamp) does the ordering. */
export async function readPage(
  db: AquillaDb,
  input: ReadPageInput,
): Promise<ReadPageResult> {
  const limit = Math.max(
    1,
    Math.min(TEAM_MESSAGE_PAGE_MAX, Math.floor(input.limit ?? TEAM_MESSAGE_PAGE_DEFAULT)),
  )
  const cursorId = input.after ?? input.before
  let cursor: { created_at: unknown; id: string } | null = null
  if (cursorId !== undefined) {
    cursor = await db
      .prepare("SELECT created_at, id FROM team_messages WHERE id = ? AND project_id = ?")
      .bind(cursorId, input.projectId)
      .first<{ created_at: unknown; id: string }>()
    if (!cursor) return { status: "invalid_cursor" }
  }

  const scope =
    input.threadId === undefined ? "thread_id IS NULL" : "thread_id = ?"
  const scopeBind = input.threadId === undefined ? [] : [input.threadId]
  const forward = input.after !== undefined
  // Ascending for `after` (catching a live tail up), descending otherwise so
  // an unanchored read is the NEWEST page; the rows are reversed below.
  const compare = forward ? ">" : "<"
  const order = forward ? "ASC" : "DESC"
  const cursorClause = cursor
    ? `AND (created_at, id) ${compare} (CAST(? AS timestamptz), ?)`
    : ""
  const cursorBind = cursor ? [toIso(cursor.created_at), cursor.id] : []

  const { results } = await db
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM team_messages
        WHERE project_id = ? AND ${scope} ${cursorClause}
        ORDER BY created_at ${order}, id ${order} LIMIT ?`,
    )
    .bind(input.projectId, ...scopeBind, ...cursorBind, limit + 1)
    .all<MessageRow>()

  const hasMore = results.length > limit
  const window = hasMore ? results.slice(0, limit) : results
  const messages = (forward ? window : [...window].reverse()).map(messageDto)
  return {
    status: "ok",
    page: {
      messages,
      // Only a backwards read can offer an older page; a forward read has
      // already been anchored by the caller.
      nextBefore: !forward && hasMore && messages.length > 0 ? messages[0].id : null,
      hasMore,
    },
  }
}
