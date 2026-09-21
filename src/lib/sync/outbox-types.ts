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

import type { CameraState } from "@/lib/sync/cells-read-types"
import type { TermRendering, TermMatchOptions } from "@/lib/terminology/types"

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
  | "cell.audio.rename"
  | "cell.audio.trim"
  | "cell.audio.place"
  | "cell.audio.measure"
  // Stage 4: one edge between a subtitle cell and an audio cue
  // (contributor-level; non-chain-mutating).
  | "cell.link.set"
  // Back-translation (contributor-level; non-chain-mutating).
  | "cell.backtranslation.set"
  // File lifecycle.
  | "file.create"
  // File label rename (contributor-level; non-chain-mutating).
  | "file.rename"
  | "file.corpus.set"
  // Soft-delete a file (project_lead+; non-chain-mutating).
  | "file.delete"
  // Restore a soft-deleted file (project_lead+; non-chain-mutating).
  | "file.restore"
  // Comments (non-chain-mutating; contributor-level).
  | "comment.create"
  | "comment.edit"
  | "comment.delete"
  | "comment.resolve"
  // Terminology concepts (project-level, non-chain-mutating). Carry the
  // `__project__` sentinel fileId like comment.*; the concept id is in the
  // payload. AQU-1006 follow-up — see sync-worker/src/events/types.ts for why
  // these exist (the settings blob lost concurrent adds).
  //
  // TWO authority levels, enforced server-side by termbase-authority.ts:
  // `term.create` with status 'draft' is a SUGGESTION any contributor may
  // make; every other term write BINDS (it changes what the rule engine
  // enforces for everyone) and needs the org's `termbaseEditMinRole`.
  | "term.create"
  | "term.update"
  | "term.delete"
  | "term.approve"
  | "term.reject"
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
  | "cell.lane.retime"
  // Timeline editor: set/clear a file's core video URL (stored in files.meta).
  | "file.video.set"
  | "file.timing.set"
  // Stage 1 (first-class timeline tracks): one track's presentation overrides
  // — rename, reorder, group — also in files.meta. DORMANT on arrival: the
  // pipeline ships complete, but nothing emits this kind until stage 3 puts
  // renaming and adding tracks in the UI.
  | "file.track.set"
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
  mode: "single" | "batch" | "paragraph" | "agent" | "read"
  projectState: {
    sourceLanguage: string
    targetLanguage: string
    approvedExampleCount: number
    /** Source-token coverage of the examples actually placed in the prompt. */
    evidenceCoverage?: number
    /** Independent-example strength, normalized to 0–1. */
    evidenceWeight?: number
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
    value?: string
    valueHtml?: string
    /** AQU-847 / AQU-646: corrected source text for a MEDIA section. An
     *  imported media cell's `value` is the import filename, so the user's
     *  edit lands here — the field `effectiveSourceText` (and therefore export
     *  and AI) reads. The stored `value` is left untouched; the chain head
     *  still advances, so targets go stale. */
    transcription?: string
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
    /** AQU-646: an OPEN string. `cell_audio.slot` is unconstrained TEXT, and an
     *  extra target-audio track addresses its takes by its own track id. The
     *  two well-known values are "recording" and "generatedVoice". */
    slot: string
    mimeType?: string
    voiceId?: string
    referenceAudioId?: string
    durationMs?: number
    /** AQU-646 round 8: the take's permanent display name. */
    label?: string
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
    /** Scopes the sibling-deselect only; it is never written onto the row, so
     *  select cannot move a clip between slots. Open string — see attach. */
    slot: string
  }
  "cell.audio.remove": {
    audioId: string
  }
  // AQU-646 round 8: rename a take — label only, never selection/trims.
  "cell.audio.rename": {
    audioId: string
    label: string | null
  }
  /**
   * The clip's COMPLETE playback trim window — both ends always stated, null
   * meaning "back to the clip edge". Required-and-nullable rather than
   * optional: an absent field is exactly what made "no opinion" and "clear it"
   * indistinguishable, so a re-attach carrying word timings wiped the window a
   * take had just been given. Sets nothing else.
   */
  "cell.audio.trim": {
    audioId: string
    trimStartMs: number | null
    trimEndMs: number | null
  }
  /**
   * AQU-646 stage 3: where THIS take sits against the line it performs, as an
   * offset in ms from the line's own start. May be negative (a take that leads
   * its line) and `0` is a real value.
   *
   * ITS OWN KIND, NEVER RIDING ATTACH. The anchor used to live on the CELL
   * (`cell.lane.retime`'s `targetOffsetMs` → `cells.metadata`), which was exact
   * while a line could hold one dub; with extra target tracks two takes share a
   * line and would share one anchor, so dragging one chip would move the other.
   * Absence has to keep meaning exactly one thing — "never placed by hand" —
   * which is why this cannot be a field on attach, where absence would also
   * mean "this attach had no opinion".
   *
   * `null` CLEARS the placement back to the line's start. Required-and-nullable
   * for the reason `cell.audio.trim` is: an optional field made "no opinion"
   * and "clear it" indistinguishable and cost every take its trim window once
   * already.
   */
  "cell.audio.place": {
    audioId: string
    targetOffsetMs: number | null
  }
  // Duration backfill for takes that predate duration capture. The server
  // fills only a NULL duration_ms — never selection/url/slot/trims — so
  // measuring an arbitrary take can never change which take is active.
  "cell.audio.measure": {
    audioId: string
    durationMs: number
  }
  /**
   * Stage 4: link or unlink ONE subtitle cell and ONE audio cue. The subtitle
   * side rides the envelope (fileId/cellId), the cue rides the payload.
   *
   * `linked` is required and boolean — an unlink is a stated `false`, never an
   * absent field. Same rule as the trim window above, and for the same reason:
   * absence must never be the way something is expressed.
   */
  "cell.link.set": {
    kind: "text-audio"
    toFileId: string
    toCellId: string
    linked: boolean
    origin: "auto" | "manual"
    confidence: number | null
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
    corpusMarker?: string
  }
  // Rename a file's display label. Non-chain-mutating (parentId omitted).
  "file.rename": {
    name: string
  }
  // Set/clear the file's sidebar corpus group. Null clears it (Ungrouped).
  "file.corpus.set": {
    corpusMarker: string | null
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

  // ── Terminology concepts (project-level, non-chain-mutating) ────────────
  "term.create": {
    conceptId: string // client-generated uuid; the projection's primary key
    sourceTerm: string
    renderings: TermRendering[]
    /** 'draft' = suggested, compiles to no rules; 'active' = enforced now. */
    status: "active" | "draft" | "deprecated"
    notes?: string
    caseSensitive?: boolean
    match?: TermMatchOptions
  }
  // Partial patch: only the keys present are written, so two people editing
  // different fields of one concept both survive. `renderings` is replaced
  // wholesale when present (a rendering has no stable id to merge on).
  "term.update": {
    conceptId: string
    sourceTerm?: string
    renderings?: TermRendering[]
    notes?: string
    caseSensitive?: boolean
    match?: TermMatchOptions
  }
  "term.delete": {
    conceptId: string // soft-delete: stamps deleted_at
  }
  "term.approve": {
    conceptId: string // draft -> active
  }
  "term.reject": {
    conceptId: string
    mode: "delete" | "deprecate"
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
    cameraState?: CameraState | null
    /**
     * AQU-646: the client's own line number for this row, from her character
     * sheet's `Line #` column. The projection merges it into cells.metadata as
     * { line_number: value } beside cast_name. Omitted when her sheet had no
     * such column.
     */
    lineNumber?: string | null
  }

  // Timeline editor: retime a cell (move/stretch). cellId is on the envelope.
  "cell.retime": {
    startMs: number
    endMs: number
  }
  // AQU-646 round 6: per-LANE presentation timing (subtitle span / target-audio
  // start) merged into source-side metadata. number sets, null clears,
  // undefined = untouched. Absolute file ms, EXCEPT targetOffsetMs.
  "cell.lane.retime": {
    subtitleStartMs?: number | null
    subtitleEndMs?: number | null
    /** Round 8: dub anchor RELATIVE to the cell's own start. May be negative. */
    targetOffsetMs?: number | null
    /** Legacy absolute dub anchor. Still projected so historical events replay
     *  unchanged, but nothing writes it any more. */
    targetStartMs?: number | null
  }
  // The file's audio timing mode (Original vs Free); null clears back to the
  // project-level default. Maintainer floor — structural, like the setting
  // it replaces in Project Settings.
  "file.timing.set": {
    timingMode: "dubbing" | "audioFirst" | null
  }
  // Stage 1: ONE track's presentation delta, merged per-field into
  // files.meta.trackOverrides[trackId]. `patch: null` deletes the entry —
  // dropping a user-added track, or resetting a default back to pure
  // defaults. Inside a patch, null means "clear THAT override" and an absent
  // key means "leave it alone"; `kind` has no null form because a track's
  // kind is its identity. The patch is FLAT on purpose — the projection
  // strips nulls recursively. Maintainer floor, like file.timing.set.
  //
  // The kind union is spelled out here rather than imported from
  // @/lib/timeline/tracks: this module is the wire mirror of
  // sync-worker/src/events/types.ts and stays free of app imports, so drift
  // shows up against the server, not against a local re-export.
  //
  // Stage 2 adds the two ADDED kinds ("folder" / "audio"), plus `color` (a
  // palette id, never colour values) and `sourceTrackId` (which track's cells
  // an added track lines up with, set once at creation). Both new fields have a
  // null form — clearing a colour is how you go back to the default pair.
  "file.track.set": {
    trackId: string
    patch: {
      kind?: "source-subtitles" | "source-audio" | "target-subtitles" | "target-audio" | "folder" | "audio"
      name?: string | null
      order?: number | null
      groupId?: string | null
      color?: string | null
      sourceTrackId?: string | null
    } | null
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
