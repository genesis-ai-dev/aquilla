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
  // File label rename (contributor-level; non-chain-mutating).
  | "file.rename"
  // Soft-delete a file (project_lead+; non-chain-mutating).
  | "file.delete"
  // Restore a soft-deleted file (project_lead+; non-chain-mutating).
  | "file.restore"
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
  // AQU-438: Cast/character label assignment (non-chain-mutating; contributor+).
  // Writes cast_name into cells.metadata JSONB without touching target text.
  | "cast.assign"
  // Timeline editor: retime a cell (move/stretch). Non-chain-mutating — updates
  // start_ms/end_ms on both sides without moving cells.event_id.
  | "cell.retime"
  // Timeline editor: set/clear a file's core video URL (stored in files.meta).
  | "file.video.set"
  // AQU-478: "accept upstream change as-is" (repin). Non-chain-mutating —
  // updates ONLY the target row's source_event_id; validated/endorsement
  // state and value are untouched. Guarded server-side by
  // expectedTargetEventId (silent no-op if a translator re-committed).
  | "target.cell.repin"

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

/** Durable context for reproducing and evaluating one machine draft. */
export interface AiDraftProvenance {
  model: string
  provider: string
  promptVersion: string
  exampleIds: string[]
  generatedAt: number
  mode: "single" | "batch" | "paragraph" | "agent"
  projectState: {
    sourceLanguage: string
    targetLanguage: string
    approvedExampleCount: number
  }
}

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
    startMs?: number
    endMs?: number
    // Timeline-segment-model (Scope A).
    medium?: string
    sequenceIndex?: number
    transcription?: string
    cameraState?: string
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
    startMs?: number
    endMs?: number
    /**
     * AQU-538: target-language lane this event addresses. Absent/'' = the
     * file's single configured target language (the default lane — every
     * pre-lane event). Part of the cells row key server-side, and of the
     * AD-2 chain slot for non-default lanes.
     */
    targetLang?: string
  }
  "target.cell.commit": {
    value: string
    valueHtml?: string
    /** AQU-538: target-language lane. Absent/'' = default lane. */
    targetLang?: string
    /**
     * AD-9 staleness pin: the source row's `event_id` as observed at commit
     * time. Null when no source counterpart exists (target-owned cell).
     */
    sourceEventId?: string | null
    /**
     * AQU-177 / search-and-replace: when true, the cell-service projector
     * re-anchors prior validations to the new head rather than dropping them
     * (Q25 event-anchoring override). Only set by the replace-all path.
     */
    retain_validations?: boolean
    /**
     * AQU-177: audit metadata for replace operations. Records the find/replace
     * query strings for per-cell history display and audit log.
     */
    search_query?: string
    replace_string?: string
    /**
     * AQU-292 / AI provenance: when true, tags this commit as machine-drafted
     * (the `cell.commit.llm-accept` variant per AD-2). Set by the AI completion
     * path (useCompletion → commitCompletedCell). Human edits omit this field
     * entirely — the server projection uses its presence to track `ai_drafted`
     * on the cell row until a human edit or validation clears it.
     */
    ai_suggestion?: true
    /** Model, prompt, retrieval, and project-state snapshot for this draft. */
    ai_draft?: AiDraftProvenance
    /**
     * Translation-agent provenance: the agent_runs ledger row this commit
     * came from. Injected server-side at stage time (agent implementation
     * plan, emit-stage.ts) and preserved verbatim by the client Apply path
     * (src/lib/agent/apply.ts) so "undo run X" can find the run's events.
     */
    agent_run_id?: string
    /**
     * Compensating-undo provenance: set when this commit REVERSES an applied
     * agent draft (restores the pre-run value). Carries the undone run's id so
     * the ledger can count undos per run — deliberately NOT agent_run_id (an
     * undo restores human text and must not inflate a run's applied count) and
     * never paired with ai_suggestion. Emitted by src/lib/agent/undo.ts.
     */
    undo_of_agent_run_id?: string
    /**
     * AQU-186 / harmonization: when present, tags this commit as a harmonize
     * sweep event (`cell.commit.harmonize` variant per AD-2). The server uses
     * this to trigger the AD-14 endorsement-revocation cascade and the
     * harmonize-affected-validation comment thread. Only set by emitCellHarmonize.
     */
    harmonize_origin?: {
      /** Stable id of the built-in check or custom rule that drove the sweep. */
      rule_or_check_id: string
      /** How the replacement was computed. */
      proposal_kind: "cached-regex" | "batch-regex" | "per-cell"
      /** Optional id linking per-cell proposals back to a parent sweep session. */
      parent_proposal_id?: string
    }
  }
  "target.cell.delete": {
    /** AQU-538: target-language lane whose row is deleted. Absent/'' = default lane. */
    targetLang?: string
  }
  "target.cell.reorder": {
    anchorCellId: string | null
    /** AQU-538: target-language lane. Absent/'' = default lane. */
    targetLang?: string
  }

  "cell.validate": {
    /** The target.cell.commit / target.cell.create event being validated. */
    editEventId: string
    /**
     * AQU-538: lane of the target row being validated. Omitted on the wire for
     * the default lane (`''`). Validation is projected per lane so a cell can
     * be validated in one lane and unvalidated in another.
     */
    targetLang?: string
  }
  "cell.unvalidate": {
    editEventId: string
    /** AQU-538: lane of the target row being unvalidated. Omitted for `''`. */
    targetLang?: string
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
    /** Non-destructive playback trim window into the clip, in ms. */
    trimStartMs?: number
    trimEndMs?: number
    timings?: { word: string; t0: number; t1: number; start: number; end: number }[]
    /** AQU-646: ASR transcript of the clip's trim window (media source segments
     *  only) — the server lands it on the source cell's `transcription`. */
    transcription?: string
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
    sourceTextDirection?: "ltr" | "rtl"
    targetTextDirection?: "ltr" | "rtl"
    /** Timeline-segment-model order lens: 'time' | 'sequence'. */
    orderedBy?: string
  }
  // Rename a file's display label. Non-chain-mutating (parentId omitted).
  // Mirrors sync-worker/src/events/types.ts. (Corpus/grouping marker is not
  // server-backed yet — name only.)
  "file.rename": {
    name: string
  }
  // Soft-delete a file (project_lead+). Stamps `files.deleted_at`; cells and
  // audio are retained (R2 wipe deferred). Non-chain-mutating (parentId omitted).
  "file.delete": Record<string, never>
  // Restore a soft-deleted file (project_lead+). Clears `files.deleted_at`.
  // All cells and audio remain intact. Non-chain-mutating (parentId omitted).
  "file.restore": Record<string, never>

  // ── Comments (non-chain-mutating) ────────────────────────────────────────
  "comment.create": {
    commentId: string // client-generated ulid
    scope: CommentScope
    body: string // markdown OK
    parentCommentId: string | null // null = top-level thread; non-null = reply
    // AQU-692: snapshot of the cell's target text at thread-creation time, for
    // the "Translation changed since this thread was created" badge. Only
    // meaningful on a root (parentCommentId === null); omit/null for replies and
    // for scopes with no target text. A missing value is an unknown baseline.
    createdForTranslated?: string | null
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

  // AQU-438: Cast/character label assignment.
  // Non-chain-mutating: does NOT move cells.event_id, does NOT touch target text.
  // The projection writes castName into cells.metadata.cast_name on the source row.
  // AQU-439: extended with optional cameraState so an angle-embedded label
  // ("Mary Magdalene   (on)") can be split on import and both voice + angle
  // are persisted atomically in one event.
  "cast.assign": {
    /**
     * The cast/character name for the voice actor. Null clears the label.
     */
    castName: string | null
    /**
     * AQU-439: Optional camera-angle override. When present, the projection
     * also updates cells.camera_state. Omitted when no angle was supplied.
     */
    cameraState?: "on" | "mixed" | "off" | null
  }

  // Timeline editor: retime a cell (move/stretch). cellId is on the envelope.
  "cell.retime": {
    startMs: number
    endMs: number
  }
  // Timeline editor: set/clear a file's core video URL (timeline preview).
  "file.video.set": {
    coreMediaUrl: string | null
  }

  // AQU-478: repin ("accept upstream change as-is"). cellId rides on the
  // envelope. See sync-worker/src/events/types.ts for the full contract.
  "target.cell.repin": {
    /** The (now-current) source row's event_id to pin the target to. */
    sourceEventId: string
    /** The target row's event_id as observed when the reviewer opened the
     *  review panel — the server no-ops if the head has since moved. */
    expectedTargetEventId: string
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
