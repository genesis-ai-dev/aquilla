/**
 * Client-side mirror of the sync-worker's AD-2 event grammar
 * (`sync-worker/src/events/types.ts`). Keep field names aligned with the
 * server's `RawEvent<K>` — the wire format is identical.
 *
 * Differences from the legacy `cqrs-types.ts` (kept around during 2c-α for
 * back-compat with the in-flight Y.Doc-mirrored writers):
 *
 *  - Prefixed event kinds (`source.cell.*`, `target.cell.*`). Authorization
 *    on the server reads the prefix; `source.*` is admin-/importer-only,
 *    `target.*` is contributor+.
 *  - `parentId` is on the envelope, not the payload. Required for every
 *    cell-mutating kind except `*.create` (genesis) and `file.create`.
 *  - `target.cell.commit` carries `sourceEventId` in its payload — the AD-9
 *    pin onto the source row's `event_id` as observed at commit time.
 */

// ── Kind union (must mirror sync-worker/src/events/types.ts) ──────────────

export type OutboxEventKind =
  // Source-side cell events (importer / admin only).
  | "source.cell.create"
  | "source.cell.commit"
  | "source.cell.delete"
  | "source.cell.reorder"
  // Target-side cell events (translator).
  | "target.cell.create"
  | "target.cell.commit"
  | "target.cell.delete"
  | "target.cell.reorder"
  // Validation.
  | "cell.validate"
  | "cell.unvalidate"
  // QA rule waivers (contributor-level; non-chain-mutating).
  | "cell.waive"
  | "cell.unwaive"
  // Cell audio attachments (contributor-level; non-chain-mutating).
  | "cell.audio.attach"
  | "cell.audio.select"
  | "cell.audio.remove"
  // Back-translation (contributor-level; non-chain-mutating).
  | "cell.backtranslation.set"
  // File lifecycle.
  | "file.create"
  // Comments (non-chain-mutating; contributor-level).
  | "comment.create"
  | "comment.edit"
  | "comment.delete"
  | "comment.resolve"
  // Assignments (project-level, non-chain-mutating; project-lead+). Carry a
  // fileId on the envelope for auth/routing like comment.*; scope is in the payload.
  | "assignment.create"
  | "assignment.reassign"
  | "assignment.unassign"

// ── Comment scope ─────────────────────────────────────────────────────────

/**
 * Discriminated union for where a comment is anchored. The `kind` field lets
 * the server projection and the read API handle all three variants without
 * any schema migration when new scopes are added.
 */
export type CommentScope =
  | { kind: "cell"; fileId: string; cellId: string }
  | { kind: "file"; fileId: string }
  | { kind: "project" }

// ── Per-kind payload shapes ───────────────────────────────────────────────

export interface OutboxEventPayloads {
  "source.cell.create": {
    cellId: string
    anchorCellId?: string | null
    value: string
    valueHtml?: string
    type?: string
    canonicalRef?: string
    metadata?: Record<string, unknown>
  }
  "source.cell.commit": {
    value: string
    valueHtml?: string
  }
  "source.cell.delete": Record<string, never>
  "source.cell.reorder": {
    anchorCellId: string | null
  }

  "target.cell.create": {
    cellId: string
    anchorCellId?: string | null
    value: string
    valueHtml?: string
    type?: string
  }
  "target.cell.commit": {
    value: string
    valueHtml?: string
    /**
     * AD-9 staleness pin: the source row's `event_id` as observed at commit
     * time. Null when no source counterpart exists (target-owned cell).
     */
    sourceEventId?: string | null
  }
  "target.cell.delete": Record<string, never>
  "target.cell.reorder": {
    anchorCellId: string | null
  }

  "cell.validate": {
    /** The target.cell.commit / target.cell.create event being validated. */
    editEventId: string
  }
  "cell.unvalidate": {
    editEventId: string
  }

  // QA rule waivers. One row per (cell, rule); DELETE-on-unwaive.
  "cell.waive": {
    ruleId: string
    reason?: string
  }
  "cell.unwaive": {
    ruleId: string
  }

  // Audio attachments. Bytes already live in R2 before these are emitted.
  "cell.audio.attach": {
    audioId: string
    url: string
    slot: "recording" | "generatedVoice"
    mimeType?: string
    voiceId?: string
    referenceAudioId?: string
    durationMs?: number
    timings?: { word: string; t0: number; t1: number; start: number; end: number }[]
  }
  "cell.audio.select": {
    audioId: string
    slot: "recording" | "generatedVoice"
  }
  "cell.audio.remove": {
    audioId: string
  }

  /**
   * Back-translation event. Non-chain-mutating (parentId omitted).
   * Emitted by the BT tab when a statistical or polished BT is saved.
   * The `targetEventId` pins the BT to the specific target commit it
   * describes — staleness is detected when `cells.event_id` ≠ `targetEventId`.
   */
  "cell.backtranslation.set": {
    btText: string
    btHtml?: string
    /** The target.cell.commit event_id this BT was generated from. */
    targetEventId: string
    /** True when the LLM polish pass has been applied. */
    polished: boolean
  }

  "file.create": {
    name: string
    fileType: string
    sourceLanguage?: string
    targetLanguage?: string
  }

  // ── Comments (non-chain-mutating) ────────────────────────────────────────
  "comment.create": {
    commentId: string // client-generated ulid
    scope: CommentScope
    body: string // markdown OK
    parentCommentId: string | null // null = top-level thread; non-null = reply
  }
  "comment.edit": {
    commentId: string
    body: string
  }
  "comment.delete": {
    commentId: string // soft-delete: sets body="" and deleted_at
  }
  "comment.resolve": {
    commentId: string // top-level only; server noops on a reply id
    resolved: boolean
  }

  // ── Assignments (project-level, non-chain-mutating) ──────────────────────
  "assignment.create": {
    assignmentId: string // client-generated uuidv7 — the assignment's stable key
    scopeKind: "books" | "chapters"
    /** One entry per assigned unit; `chapter` present for 'chapters' (e.g.
     *  { fileId, chapter: "GEN 1" }), fileId-only for 'books'. */
    scope: { fileId: string; chapter?: string }[]
    scopeLabel: string
    assigneeUserId: number
    deadline?: string | null
    note?: string | null
  }
  "assignment.reassign": {
    assignmentId: string
    assigneeUserId: number
  }
  "assignment.unassign": {
    assignmentId: string
  }
}

export type OutboxPayloadFor<K extends OutboxEventKind> = OutboxEventPayloads[K]

// ── Event envelope ────────────────────────────────────────────────────────

/**
 * Wire-format raw event. Mirrors `RawEvent<K>` on the server.
 *
 * Genesis-kind events (`source.cell.create`, `target.cell.create`,
 * `file.create`) have `parentId = null`. All other cell-mutating kinds carry
 * the chain-head event id of the row they're modifying.
 */
export interface OutboxRawEvent<K extends OutboxEventKind = OutboxEventKind> {
  /** Client-generated UUIDv7. The events INSERT is idempotent on this. */
  id: string
  /** Bump when an existing payload's shape changes. */
  schemaVersion: number
  kind: K
  projectId: string
  /** Omitted for project-scope events. */
  fileId?: string
  /** Omitted for file-scope events. */
  cellId?: string
  /**
   * AD-2 parent-chain pointer. null only on genesis events
   * (`*.create` and `file.create`). Server's projection guard reads this.
   */
  parentId?: string | null
  /** Username; server validates against the JWT claim. */
  author: string
  payload: OutboxPayloadFor<K>
  /** Wallclock at emit. Server canonical ordering is `serverSeq`. */
  clientTs: number
}

/** Schema version that ships with Phase 2c-α. Bump on payload changes. */
export const OUTBOX_SCHEMA_VERSION = 1

// ── Legacy Cqrs* aliases (moved from the now-deleted cqrs-types.ts shim) ──
// These names predate the AD-2 OutboxRawEvent grammar. Callers still using
// them are correct; no rename is required. Do not add new callers — prefer
// the Outbox* names in new code.
export type CqrsEventKind = OutboxEventKind
export type CqrsEventPayloads = OutboxEventPayloads
export type CqrsPayloadFor<K extends OutboxEventKind> = OutboxPayloadFor<K>
export type CqrsRawEvent<K extends OutboxEventKind = OutboxEventKind> = OutboxRawEvent<K>
export const CQRS_SCHEMA_VERSION = OUTBOX_SCHEMA_VERSION

// ── Type guards ───────────────────────────────────────────────────────────

const CHAIN_MUTATING_KINDS: ReadonlySet<OutboxEventKind> = new Set<OutboxEventKind>([
  "source.cell.create",
  "source.cell.commit",
  "source.cell.delete",
  "source.cell.reorder",
  "target.cell.create",
  "target.cell.commit",
  "target.cell.delete",
  "target.cell.reorder",
])

const GENESIS_KINDS: ReadonlySet<OutboxEventKind> = new Set<OutboxEventKind>([
  "source.cell.create",
  "target.cell.create",
  "file.create",
])

/**
 * True iff the event kind advances `cells.event_id` (the chain head). Used
 * by the reconciler to know which `event.applied` frames invalidate cell
 * projections and by validation gates to know which kinds carry `parentId`.
 */
export function isChainMutatingKind(kind: OutboxEventKind): boolean {
  return CHAIN_MUTATING_KINDS.has(kind)
}

/** True iff the event kind is a genesis event (parentId must be null). */
export function isGenesisKind(kind: OutboxEventKind): boolean {
  return GENESIS_KINDS.has(kind)
}
