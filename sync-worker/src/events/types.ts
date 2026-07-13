// Event envelope + per-kind payload types for the AD-2 / AD-9 event log.
//
// Cell-level event kinds carry a `source.` or `target.` prefix so role-policy
// can gate on the kind alone (`source.*` requires admin / import-bot; `target.*`
// requires contributor+). Source-vs-target on the same `cell_id` are
// independent chains because they live in separate files (`file_id` differs);
// pairing across the two chains is implicit via the shared `cell_id`.
//
// Every event carries `parent_id` — the prior winning event on this cell's
// `(project_id, file_id, cell_id)` chain. NULL only for genesis events
// (`source.cell.create` / `target.cell.create`). The projection's first-child-
// of-parent rule (AD-2) reads this column to decide whether to advance the
// `cells.event_id` head or leave the event as a stale sibling in history.
//
// Adding a new EventKind requires:
//   1. A row in EventPayloads.
//   2. A REQUIRED_ROLE entry in role-policy.ts.
//   3. A dispatch.ts case.
//   4. (If it mutates the projection) a handler in handlers/.
// TypeScript's exhaustiveness check enforces (1)–(3).

export type EventKind =
  // Source-side cell events (importer / admin only).
  | 'source.cell.create'
  | 'source.cell.commit'
  | 'source.cell.delete'
  | 'source.cell.reorder'
  // Target-side cell events (translator).
  | 'target.cell.create'
  | 'target.cell.commit'
  | 'target.cell.delete'
  | 'target.cell.reorder'
  // Validation (reviewer-level).
  | 'cell.validate'
  | 'cell.unvalidate'
  // QA rule waivers (contributor-level). Non-chain-mutating — they record a
  // per-(cell, rule) dismissal of a QA infraction; they don't move cells.event_id.
  | 'cell.waive'
  | 'cell.unwaive'
  // Cell audio attachments (contributor-level). Metadata only; bytes in R2.
  // Non-chain-mutating — they don't move cells.event_id.
  | 'cell.audio.attach'
  | 'cell.audio.select'
  | 'cell.audio.remove'
  // Audio validation (reviewer-level). Non-chain-mutating — approves/withdraws
  // approval of a cell's selected clip; does not move cells.event_id. Distinct
  // from cell.validate, which is text-side (cells.validated / cell_validators).
  | 'cell.audio.validate'
  | 'cell.audio.unvalidate'
  // File lifecycle.
  | 'file.create'
  // File label rename (contributor-level). Non-chain-mutating — updates the
  // file's display name on the existing row; does not move cells.event_id.
  | 'file.rename'
  // Soft-delete a file (project_lead+). Non-chain-mutating — stamps
  // `files.deleted_at`; cells and audio are retained. R2 wipe is deferred.
  | 'file.delete'
  // Restore a soft-deleted file (project_lead+). Non-chain-mutating — clears
  // `files.deleted_at`. Cells and audio remain intact throughout.
  | 'file.restore'
  // Comments (non-chain-mutating; contributor-level).
  | 'comment.create'
  | 'comment.edit'
  | 'comment.delete'
  | 'comment.resolve'
  // Back-translations (non-chain-mutating; contributor-level).
  // Does NOT move cells.event_id; does NOT affect validations or endorsements.
  | 'cell.backtranslation.set'
  // Assignments (project-level, non-chain-mutating; project-lead+). Carry a
  // fileId on the envelope for auth/routing like comments, but their scope is
  // project-level — resolved into assignment_cells from the payload.
  | 'assignment.create'
  | 'assignment.reassign'
  | 'assignment.unassign'
  // AD-9 source-link lifecycle. Non-chain-mutating; project-level. Emitted by
  // auth-worker on link-source and detach-source. The payload carries
  // `sourceProjectId` (non-null = link established; null = link cleared /
  // detached). sync-worker receives this via the shared events table and uses
  // it to invalidate any cached upstream-resolution in the stale-source route.
  | 'project.link-source'
  // AQU-438: Cast/character label assignment. Non-chain-mutating (does NOT move
  // cells.event_id). Writes cast_name into cells.metadata JSONB without touching
  // target text. Contributor-level — a PM/project-lead labels cells for voice actors.
  | 'cast.assign'
  // Timeline editor: retime a cell (move/stretch). Non-chain-mutating — updates
  // start_ms/end_ms on both the source and target rows without moving cells.event_id.
  | 'cell.retime'
  // Timeline editor: set/clear a file's core video URL (timeline preview master
  // clock), stored in files.meta JSON. Non-chain-mutating; file-level.
  | 'file.video.set'
  // AQU-476: live source links — mirror engine. Server-emitted only (the
  // mirror sync engine in link-sync.ts; never a client outbox kind). Mirror
  // events replicate an ordering the UPSTREAM already arbitrated, so they
  // carry parentId: null and are EXEMPT from CHAIN_MUTATING_KINDS / the
  // chain-claims gate (see event-projection.ts) — applied instead behind a
  // monotonic `payload.upstream.seq > cells.upstream_seq` guard in the
  // projection SQL itself. See the linked-projects design spec §4.
  | 'source.cell.mirror'
  // Downstream `files` row for an upstream file created post-seed. Same
  // server-only, non-chain-mutating status as source.cell.mirror.
  | 'file.mirror'
  // Audit-trail record of a non-empty mirror batch (an empty fold advances
  // `projects.source_link_cursor` directly with no event). No cells
  // projection — purely a history record for the review panel (AQU-478).
  | 'link.cursor.advance'
  // AQU-478: "accept upstream change as-is" — reviewer(300)+ asserts a
  // translation still stands against the new source. Non-chain-mutating:
  // the chain head does NOT move, so validations/endorsements survive
  // (deliberate — spec §7). Guarded: the projection only applies when the
  // target row's CURRENT event_id still equals `expectedTargetEventId`, so
  // a translator's concurrent re-commit makes this a no-op instead of
  // clobbering a fresher pin (the route reports skips for bulk repin).
  | 'target.cell.repin'

// ── Comment scope ─────────────────────────────────────────────────────────

/**
 * Discriminated union for where a comment is anchored. Adding a new variant
 * (e.g. {kind:"project"}) requires no grammar migration — just a new union
 * member here and a corresponding branch in the projector.
 */
export type CommentScope =
  | { kind: 'cell'; fileId: string; cellId: string }
  | { kind: 'file'; fileId: string }
  | { kind: 'project' }

// Payload shape per event kind. Using an interface (not Record) so that
// EventPayloads[K] gives type-safe lookups without `as` casts.
export interface EventPayloads {
  // ── Source-side ────────────────────────────────────────────────────────
  'source.cell.create': {
    cellId: string
    anchorCellId?: string | null
    value: string
    valueHtml?: string
    type?: string
    canonicalRef?: string
    metadata?: Record<string, unknown>
    startMs?: number
    endMs?: number
    // Timeline-segment-model (Scope A) — set at create, not overwritten later.
    medium?: string
    sequenceIndex?: number
    transcription?: string
    cameraState?: string
  }
  'source.cell.commit': {
    value: string
    valueHtml?: string
  }
  'source.cell.delete': Record<string, never>
  'source.cell.reorder': {
    anchorCellId: string | null
  }

  // ── Target-side ────────────────────────────────────────────────────────
  'target.cell.create': {
    cellId: string
    anchorCellId?: string | null
    value: string
    valueHtml?: string
    type?: string
    startMs?: number
    endMs?: number
    // Timeline-segment-model (Scope A) — set at create, not overwritten later.
    medium?: string
    sequenceIndex?: number
    transcription?: string
    cameraState?: string
  }
  'target.cell.commit': {
    value: string
    valueHtml?: string
    /**
     * UUIDv7 of the source row's `event_id` as observed by the editor at
     * commit time. Stored on `cells.source_event_id` and used for AD-9
     * staleness derivation (`source.event_id != target.source_event_id`).
     * Null for target-owned cells with no source counterpart.
     */
    sourceEventId?: string | null
    /**
     * AQU-292 / AI provenance: when true, tags this commit as machine-drafted
     * (the `cell.commit.llm-accept` variant per AD-2). Set by the AI completion
     * path (useCompletion → commitCompletedCell). Human edits omit this field
     * entirely — the projection tracks `cells.ai_drafted` until a human edit
     * or validation clears it. Forward-only: historical commits without this
     * field are treated as human-authored (ai_drafted = 0).
     */
    ai_suggestion?: true
    /**
     * Translation agent provenance: id of the agent_runs row whose staged
     * proposal produced this commit (always paired with ai_suggestion). Links
     * the event to the run ledger for observability and compensating-event
     * rollback. Absent on human edits and plain AI completions.
     */
    agent_run_id?: string
    /**
     * Compensating-undo provenance: set when this commit reverses an applied
     * agent draft (restores the pre-run value). Carries the undone run's id
     * for ledger rollups; never paired with ai_suggestion (the restored text
     * is human-authored). Written by the client undo path (src/lib/agent/undo.ts).
     */
    undo_of_agent_run_id?: string
    /**
     * AQU-186 / harmonization: when present, tags this commit as a harmonize
     * sweep event (cell.commit.harmonize variant per AD-2). The route layer
     * uses this field to enforce harmonize_min_role and to trigger the AD-14
     * endorsement-revocation cascade. Only set by the harmonize sweep path.
     */
    harmonize_origin?: {
      /** Stable id of the built-in check or custom rule that drove the sweep. */
      rule_or_check_id: string
      /** How the replacement was computed. */
      proposal_kind: 'cached-regex' | 'batch-regex' | 'per-cell'
      /** Optional id linking per-cell proposals back to a parent sweep session. */
      parent_proposal_id?: string
    }
  }
  'target.cell.delete': Record<string, never>
  'target.cell.reorder': {
    anchorCellId: string | null
  }

  // ── Validation ─────────────────────────────────────────────────────────
  'cell.validate': {
    /** The target.cell.commit / target.cell.create event being validated. */
    editEventId: string
  }
  'cell.unvalidate': {
    /** The target commit event whose validation is being withdrawn. */
    editEventId: string
    /**
     * When a maintainer is removing another user's validation, set this to
     * the username of the validator whose row should be deleted. If omitted
     * or equal to the caller's own username, the caller removes their own
     * validation (reviewer+ allowed). If set to a different username, the
     * caller must have maintainer (600) or above.
     */
    targetUsername?: string
  }

  // ── QA rule waivers ────────────────────────────────────────────────────
  // `waive` dismisses a single QA rule infraction on a cell; `unwaive`
  // restores it. Keyed by `ruleId` (one row per (cell, rule)). The DELETE-on-
  // unwaive shape mirrors validators: a row exists iff the rule is waived.
  'cell.waive': {
    /** Stable id of the QA rule whose infraction is being dismissed. */
    ruleId: string
    /** Optional human-entered justification. */
    reason?: string
  }
  'cell.unwaive': {
    ruleId: string
  }

  // ── Cell audio ─────────────────────────────────────────────────────────
  // `attach` records (and selects) a clip in its slot; `select` switches the
  // active clip; `remove` soft-deletes one. Bytes are already in R2
  // (frontier-audio:// url) before these are emitted.
  'cell.audio.attach': {
    audioId: string
    url: string
    slot: 'recording' | 'generatedVoice'
    mimeType?: string
    voiceId?: string
    referenceAudioId?: string
    durationMs?: number
    /** Non-destructive playback trim window into the clip, in ms. */
    trimStartMs?: number
    trimEndMs?: number
    timings?: { word: string; t0: number; t1: number; start: number; end: number }[]
  }
  'cell.audio.select': {
    audioId: string
    slot: 'recording' | 'generatedVoice'
  }
  'cell.audio.remove': {
    audioId: string
  }
  // AQU-508: reviewer approves the given clip (the cell's selected take). The
  // audio-validated rollup counts a cell iff its selected, live clip is
  // approved, so validating the active take marks the cell audio-validated.
  'cell.audio.validate': {
    audioId: string
  }
  'cell.audio.unvalidate': {
    audioId: string
  }

  // ── File lifecycle ─────────────────────────────────────────────────────
  'file.create': {
    /** Display name for the file in the project sidebar. */
    name: string
    /** "codex" | "vtt" | "srt" | etc. — matches `files.file_type`. */
    fileType: string
    /** ISO codes; null/undefined when unknown at import time. */
    sourceLanguage?: string
    targetLanguage?: string
    sourceTextDirection?: 'ltr' | 'rtl'
    targetTextDirection?: 'ltr' | 'rtl'
    /** Timeline-segment-model: order lens — 'time' | 'sequence'. Stored in
     *  files.meta (JSON). Absent ⇒ client treats as 'sequence'. */
    orderedBy?: string
  }
  // Rename a file's display label. Non-chain-mutating; parentId omitted.
  // (Corpus/grouping marker is not server-backed yet — name only.)
  'file.rename': {
    /** New display name for the file in the project sidebar. */
    name: string
  }
  // Soft-delete a file. Non-chain-mutating; parentId omitted.
  // Stamps `files.deleted_at`; cells and audio are retained (R2 wipe deferred).
  'file.delete': Record<string, never>
  // Restore a soft-deleted file. Non-chain-mutating; parentId omitted.
  // Clears `files.deleted_at`. All cells and audio remain intact.
  'file.restore': Record<string, never>

  // ── Comments (non-chain-mutating) ──────────────────────────────────────
  'comment.create': {
    commentId: string // client-generated ulid
    scope: CommentScope
    body: string // markdown OK
    parentCommentId: string | null // null = top-level; non-null = reply
  }
  'comment.edit': {
    commentId: string
    body: string
  }
  'comment.delete': {
    commentId: string // soft-delete: sets body="" and deleted_at
  }
  'comment.resolve': {
    commentId: string // top-level only; server noops on a reply id
    resolved: boolean
  }

  // ── Back-translations (non-chain-mutating) ─────────────────────────────
  // `btText` is the plain-text back-translation; `btHtml` is the optional
  // rich rendering. `targetEventId` pins the BT to the target cell commit it
  // was generated from — a stale BT is one whose targetEventId no longer
  // matches cells.event_id. `polished` flags that an LLM polish pass was
  // applied (shows a "polished" badge in the UI per the ai-copilot spec).
  'cell.backtranslation.set': {
    btText: string
    btHtml?: string
    /** The target.cell.commit / target.cell.create event_id this BT was generated from. */
    targetEventId: string
    /** true = LLM-polished BT; false = statistical-only. */
    polished: boolean
  }

  // ── Assignments (project-level, non-chain-mutating) ─────────────────────
  // A manager assigns a book/chapter scope to a member. One assignment.create
  // regardless of scope size — the handler resolves `scope` into the cell set
  // from the live `cells` projection.
  'assignment.create': {
    /** Client-generated id (ulid/uuid) — the assignment's stable key. */
    assignmentId: string
    scopeKind: 'books' | 'chapters'
    /**
     * One entry per assigned unit. `chapter` present for 'chapters'
     * (e.g. { fileId, chapter: "GEN 1" } -> canonical_ref LIKE "GEN 1:%");
     * fileId-only for 'books' (all source cells in the file).
     */
    scope: { fileId: string; chapter?: string }[]
    /** Human-readable label for the assigned scope, e.g. "Genesis 1-3". */
    scopeLabel: string
    /** Frontier user id of the assignee. */
    assigneeUserId: number
    /** Optional ISO date string deadline. */
    deadline?: string | null
    /** Optional instruction note. */
    note?: string | null
  }
  'assignment.reassign': {
    assignmentId: string
    assigneeUserId: number
  }
  'assignment.unassign': {
    assignmentId: string
  }

  // ── AD-9 source-link lifecycle (project-level, non-chain-mutating) ─────────
  // Emitted by auth-worker on both link-source (sourceProjectId non-null) and
  // detach-source (sourceProjectId null). sync-worker receives this event
  // when it consumes the shared events table; it does not currently gate any
  // cell chain mutations on this event but the kind must be in the union so
  // the exhaustiveness check in dispatch.ts can handle it.
  'project.link-source': {
    /** Non-null = link established / updated. Null = link cleared (detached). */
    sourceProjectId: string | null
  }

  // ── AQU-438: Cast/character label assignment (non-chain-mutating) ──────────
  // Sets cells.metadata.cast_name WITHOUT touching target text or cells.event_id.
  // Emitted by the label import panel when a PM uploads a filled cast template.
  // Idempotent JSONB merge: repeated assigns for the same cell overwrite the
  // cast_name; clearing requires a null value.
  // AQU-439: extended with optional cameraState so angle-embedded labels
  // ("Mary Magdalene   (on)") can be split on import. The projection updates
  // cells.camera_state when cameraState is present in the payload.
  'cast.assign': {
    /**
     * The cast/character name for the voice actor. Null clears the label.
     * The projection writes this into cells.metadata as { cast_name: value }.
     */
    castName: string | null
    /**
     * AQU-439: Optional camera-angle override ("on" | "mixed" | "off").
     * When present, the projection also updates cells.camera_state.
     * Null clears the column; omitting this field (undefined) is a no-op.
     */
    cameraState?: 'on' | 'mixed' | 'off' | null
  }

  // ── Timeline editor (non-chain-mutating) ────────────────────────────────
  // Retime a cell (move/stretch). cellId rides on the envelope; the projection
  // updates start_ms/end_ms on both the source and target rows.
  'cell.retime': {
    startMs: number
    endMs: number
  }
  // Set/clear a file's core video URL (timeline preview master clock), stored
  // in files.meta JSON; null clears it. File-level.
  'file.video.set': {
    coreMediaUrl: string | null
  }

  // ── AQU-476: live source links — mirror engine (server-emitted) ────────
  // Advances a downstream source cell to match the upstream. Full
  // create-grade shape (structural fields for a cell with no local row yet)
  // PLUS the fields source.cell.commit carries (value/valueHtml) — a mirror
  // can hit either a brand-new cell (post-seed upstream create) or an
  // existing one (upstream commit), so the projection is a full UPSERT.
  'source.cell.mirror': {
    value: string
    valueHtml?: string
    type?: string
    canonicalRef?: string
    anchorCellId?: string | null
    startMs?: number
    endMs?: number
    sequenceIndex?: number
    transcription?: string
    cameraState?: string
    medium?: string
    metadata?: Record<string, unknown>
    /** True = the upstream deleted this cell. Tombstone (stamp
     *  cells.tombstoned_at), never delete the downstream row. */
    deleted?: true
    /** Provenance: which upstream event/state this mirror reflects. */
    upstream: {
      projectId: string
      cellId: string
      eventId: string
      /** The upstream event's server_seq — the monotonic apply-guard key. */
      seq: number
      side: 'source' | 'target'
      contentHash: string
    }
  }
  // Downstream `files` row for an upstream file created post-seed.
  'file.mirror': {
    fileId: string
    name: string
    /** Passed through to files.meta (JSON) — same shape as file.create's
     *  language/orderedBy fields, merged rather than replacing wholesale. */
    meta?: Record<string, unknown>
    upstream: {
      projectId: string
      eventId: string
      seq: number
    }
  }
  // Audit-trail record of one non-empty mirror sync batch. No cells
  // projection; purely a history row for the review panel (AQU-478).
  'link.cursor.advance': {
    upstreamProjectId: string
    fromSeq: number
    toSeq: number
    cellCount: number
  }

  // ── AQU-478: repin (accept upstream change as-is) ──────────────────────
  // Reviewer-level "translation still correct against the new source."
  // Updates ONLY cells.source_event_id on the target row — never value,
  // event_id, validated, or endorsement_count. Guarded by
  // expectedTargetEventId so a race with a translator's concurrent
  // target.cell.commit resolves to a no-op (the fresher pin wins) rather
  // than clobbering it. See event-projection.ts's 'target.cell.repin' case.
  'target.cell.repin': {
    /** The (now-current) source row's event_id to pin the target to. */
    sourceEventId: string
    /** The target row's event_id as observed by the reviewer when they
     *  opened the review panel. The UPDATE's WHERE clause requires
     *  cells.event_id to still equal this — if a translator re-committed
     *  in the meantime, the head moved and this repin silently no-ops. */
    expectedTargetEventId: string
  }
}

export type PayloadFor<K extends EventKind> = EventPayloads[K]

/**
 * Raw event as received from the client (before authorization).
 *
 * `parentId` is REQUIRED for every cell-mutating kind except the genesis
 * `*.create` kinds (where it must be null). The dispatcher's per-kind
 * handler enforces this — the envelope type allows null/undefined for
 * `*.create` events and a string for the rest.
 */
export interface RawEvent<K extends EventKind = EventKind> {
  /** Client-generated UUIDv7. */
  id: string
  /** Bump when an existing payload shape changes; additive optional fields don't require a bump. */
  schemaVersion: number
  kind: K
  projectId: string
  /** Omitted for project-level events. */
  fileId?: string
  /** Omitted for file-level events. */
  cellId?: string
  /**
   * Prior winning event on this cell's chain. Null for genesis events
   * (`source.cell.create` / `target.cell.create`). Required for all other
   * cell-mutating kinds — the projection's AD-2 parent-chain guard reads
   * this. File-level events (`file.create`) may also be null.
   */
  parentId?: string | null
  /** Frontier username (server validates against JWT). */
  author: string
  payload: PayloadFor<K>
  /** ms since epoch. Used for human-readable history ordering; server_seq is the canonical ordering key. */
  clientTs: number
}

/**
 * JWT claims stamped on every authorized event. The sync-worker's auth.ts
 * mints similar claims for WS upgrades; this is the event-write equivalent.
 */
export interface EventClaims {
  userId: number
  username: string
  projectId: string
  /** When token is scoped to a single file. */
  fileId?: string
  /** Numeric role level (100=viewer..700=owner). */
  roleLevel: number
  /**
   * AQU-346: role-resolution source stamped at mint time. `"platform"`
   * exempts the token from the live membership re-check (ADMIN_EMAILS
   * operators have no membership rows). Absent on older tokens.
   */
  src?: string
}
