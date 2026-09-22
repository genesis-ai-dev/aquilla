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

/** Mirrors `RenderingStatus` in src/lib/terminology/types.ts. */
export type TermRenderingStatusPayload = 'preferred' | 'admitted' | 'forbidden'

/** Mirrors `TermRendering` in src/lib/terminology/types.ts. */
export interface TermRenderingPayload {
  rendering: string
  status: TermRenderingStatusPayload
}

/** Mirrors `Concept['status']` in src/lib/terminology/types.ts. */
export type ConceptStatusPayload = 'active' | 'draft' | 'deprecated'

/** Mirrors `TermMatchOptions` in src/lib/terminology/types.ts. */
export interface TermMatchOptionsPayload {
  foldMarks?: boolean
  affixes?: boolean
  forms?: string[]
  excludedForms?: string[]
}

export type EventKind =
  // Source-side cell events (importer / admin only).
  | 'source.cell.create'
  | 'source.cell.commit'
  | 'source.cell.delete'
  | 'source.cell.reorder'
  // Versioned, metadata-only backfill. Does not advance the source text chain.
  | 'source.cell.metadata.patch'
  // Anchor-only repair (migration reconciliation, AQU-931). Non-chain-mutating —
  // moves ONLY cells.anchor_cell_id on the source row; never advances
  // cells.event_id (the AD-9 staleness comparison depends on the source head
  // moving only when content changes) and replays unconditionally on rebuild.
  | 'source.cell.reanchor'
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
  | 'cell.audio.rename'
  // Set a clip's playback trim window. Its own event because `attach` USED to
  // own the trim columns, and every re-attach that wasn't about trimming (word
  // timings, a duration heal) wiped them: "no opinion" and "cleared" were both
  // expressed as an absent field. See the payload doc below.
  | 'cell.audio.trim'
  | 'cell.audio.place'
  // Backfill a measured duration onto a take that predates duration capture.
  // Fills only a NULL duration_ms — never selects, never touches url/slot/
  // trims (a re-attach would re-select the clip and plain-assign trims).
  | 'cell.audio.measure'
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
  // Terminology concepts (non-chain-mutating; project-level).
  //
  // Concepts USED to live in the project_settings JSON blob, where every add
  // PATCHed the whole `terminology` array rebuilt from the writer's stale
  // snapshot — two people adding terms in the same minute silently destroyed
  // each other's entries (observed live, 2026-09-04 demo: five attendees added
  // terms, one survived). On the event log each write names ONE concept, so a
  // concurrent add can no longer overwrite an array it never read.
  //
  // Project-level like `assignment.*`: the envelope carries `__project__` as
  // fileId for auth/routing, and the concept id rides the payload.
  | 'term.create'
  | 'term.update'
  | 'term.delete'
  // Review-queue transitions. Separate kinds (rather than a `term.update` with
  // a status field) so the audit log distinguishes "someone edited this term"
  // from "someone approved it" — the approval trail is the point.
  | 'term.approve'
  | 'term.reject'
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
  | 'cell.lane.retime'
  // Timeline editor: set/clear a file's core video URL (timeline preview master
  // clock), stored in files.meta JSON. Non-chain-mutating; file-level.
  | 'file.video.set'
  // Pre-merge round: the file's audio timing mode (Original vs Free), stored
  // in files.meta JSON. A FILE-level distinction — the video link it interacts
  // with is per-file too. Non-chain-mutating; maintainer floor (structural,
  // same clearance as project settings).
  | 'file.timing.set'
  // Sidebar folder / corpus group for a file, stored in files.meta JSON.
  // Non-chain-mutating; contributor-level — same class as file.rename (label
  // cleanup), not track structure. Null clears the file back to Ungrouped.
  | 'file.corpus.set'
  // Stage 1 (first-class timeline tracks): one track's presentation overrides
  // — rename, reorder, group, or the whole record of a user-added track —
  // stored in files.meta JSON under `trackOverrides`. Non-chain-mutating;
  // maintainer floor (track structure is file structure).
  //
  // DORMANT on arrival: the write path ships complete and tested, but nothing
  // emits this kind until stage 3 puts renaming and adding tracks in the UI.
  // Shipping the pipeline first means stage 3 is a UI change, not a migration.
  | 'file.track.set'
  // Stage 4: one edge between a SUBTITLE cell and an AUDIO CUE, the two cue
  // lists an episode ships with. Many-to-many — a sentence the subtitles keep
  // whole may be performed as two heard lines, and one heard line may cover
  // several subtitle rows — so clusters are whatever the edges connect and
  // there is no group object. Non-chain-mutating; contributor-level.
  //
  // Written in bulk ONCE by the auto-linker at audio-VTT import, and after
  // that only by hand. Deliberately never recomputed: recomputing would
  // silently undo every manual correction on the next import.
  | 'cell.link.set'
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

export interface AiDraftProvenance {
  model: string
  provider: string
  promptVersion: string
  exampleIds: string[]
  generatedAt: number
  mode: 'single' | 'batch' | 'paragraph' | 'agent' | 'read'
  projectState: {
    sourceLanguage: string
    targetLanguage: string
    approvedExampleCount: number
    evidenceCoverage?: number
    evidenceWeight?: number
  }
}

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
    value?: string
    valueHtml?: string
    /** AQU-847 / AQU-646: corrected source text for a MEDIA section. An
     *  imported media cell's `value` is the import filename, so the user's
     *  edit lands here — the field `effectiveSourceText` (and therefore export
     *  and AI) reads. The stored `value` is left untouched; the chain head
     *  still advances, so targets go stale. */
    transcription?: string
  }
  'source.cell.delete': Record<string, never>
  'source.cell.reorder': {
    anchorCellId: string | null
  }
  'source.cell.reanchor': {
    /** The cell this cell should follow; null re-heads it (anchor chain start). */
    anchorCellId: string | null
  }
  'source.cell.metadata.patch': {
    /** Payload contract version; v1 is the only supported patch shape. */
    version: 1
    /** Shallow JSON merge into cells.metadata. Existing unrelated keys survive. */
    metadata: Record<string, unknown>
    /** Optional canonical protected source HTML produced by the v2 upgrader. */
    valueHtml?: string
    /** Optional canonical current target HTML; text/history stay untouched. */
    targetHtml?: string
  }

  // ── Target-side ────────────────────────────────────────────────────────
  //
  // AQU-538 lanes: every target-side chain-mutating payload MAY carry
  // `targetLang` — the target-language lane this event addresses. Absent or
  // '' = the file's single configured target language (the legacy/default
  // lane; every pre-lane event). The lane is part of the cells row key
  // (PRIMARY KEY …, side, target_lang) AND of the AD-2 chain slot for
  // non-default lanes (see chain-claims.ts laneQualifiedParentKey): two
  // lanes' first commits both chain on the same source head and must not
  // compete for one slot. Source-side rows/events never carry a lane.
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
    /** AQU-538: target-language lane. Absent/'' = default lane. */
    targetLang?: string
  }
  'target.cell.commit': {
    value: string
    valueHtml?: string
    /** AQU-538: target-language lane. Absent/'' = default lane. */
    targetLang?: string
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
    /** Reproducibility and effort-analysis context for the original draft. */
    ai_draft?: AiDraftProvenance
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
  'target.cell.delete': {
    /** AQU-538: target-language lane whose row is deleted. Absent/'' = default lane. */
    targetLang?: string
  }
  'target.cell.reorder': {
    anchorCellId: string | null
    /** AQU-538: target-language lane. Absent/'' = default lane. */
    targetLang?: string
  }

  // ── Validation ─────────────────────────────────────────────────────────
  'cell.validate': {
    /** The target.cell.commit / target.cell.create event being validated. */
    editEventId: string
    /**
     * AQU-538: target-language lane of the validated commit. Absent/'' =
     * default lane — same convention as target.cell.commit. A user's standing
     * validation is per-lane: validating the same cell in two lanes yields two
     * cell_validators rows.
     */
    targetLang?: string
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
    /**
     * AQU-538: target-language lane whose validation is withdrawn. Absent/'' =
     * default lane — same convention as target.cell.commit.
     */
    targetLang?: string
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
    /** Open string (AQU-646): extra target tracks use the track id as the slot. */
    slot: string
    mimeType?: string
    voiceId?: string
    referenceAudioId?: string
    durationMs?: number
    /** AQU-646 round 8: the take's PERMANENT display name ("Take 3"). */
    label?: string
    /**
     * Non-destructive playback trim window into the clip, in ms — the clip's
     * BIRTH values only. The projection COALESCEs these, so an attach may SET a
     * window but can never clear one; changing or clearing a window afterwards
     * is `cell.audio.trim`. That asymmetry is load-bearing: a re-attach that
     * has nothing to do with trimming (word timings, a duration heal) sends no
     * trim fields, and those used to be plain-assigned as NULL — silently
     * wiping the window a second after it was written.
     */
    trimStartMs?: number
    trimEndMs?: number
    timings?: { word: string; t0: number; t1: number; start: number; end: number }[]
    /**
     * AQU-646: ASR transcript of this clip (its trim window). Only sent for
     * `medium:"media"` source segments — the projection writes it to the
     * SOURCE cell row's `transcription` column so imported audio surfaces
     * translatable source text. Riding this event keeps the write at the
     * CONTRIBUTOR floor (source.cell.* are project_lead) and avoids the
     * source.cell.create UPSERT clobbering segment fields.
     */
    transcription?: string
  }
  'cell.audio.select': {
    audioId: string
    /** Open string (AQU-646): extra target tracks use the track id as the slot. */
    slot: string
  }
  // AQU-646 round 8: rename a take — label only, deliberately NOT a
  // re-attach (which would also re-select the clip). null clears.
  'cell.audio.rename': {
    audioId: string
    label: string | null
  }
  /**
   * The clip's COMPLETE playback trim window — both ends, always stated, with
   * `null` meaning "back to the clip edge". Required-and-nullable rather than
   * optional on purpose: an absent field is what made "I have no opinion"
   * indistinguishable from "clear it", and the projection could only guess.
   * Sets nothing else — not selection, slot, url, duration or timings.
   */
  'cell.audio.trim': {
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
   * Absence has to keep meaning exactly one thing — 'never placed by hand' —
   * which is why this cannot be a field on attach, where absence would also
   * mean 'this attach had no opinion'.
   *
   * `null` CLEARS the placement back to the line's start. Required-and-nullable
   * for the reason `cell.audio.trim` is: an optional field made 'no opinion'
   * and 'clear it' indistinguishable and cost every take its trim window once
   * already.
   */
  'cell.audio.place': {
    audioId: string
    targetOffsetMs: number | null
  }
  /**
   * Stage 4: link or unlink ONE subtitle cell and ONE audio cue.
   *
   * The subtitle side rides the ENVELOPE (`fileId`/`cellId`), the audio cue
   * rides the payload — the same split `comment.*` uses, so per-file auth and
   * routing work without a second lookup.
   *
   * `linked` IS REQUIRED AND BOOLEAN. Unlinking is a tombstone (`linked: 0`),
   * never a deleted row and never an absent field: an absent field meaning
   * "unlinked" is the exact shape that cost us every take's trim window in
   * stage 4.5, where "clear this" and "no opinion" became indistinguishable.
   *
   * The endpoints are the projection's primary key, so re-delivering an event
   * is a no-op and a replay of the whole log lands in the same place.
   */
  'cell.link.set': {
    /** Only `text-audio` today. The pocket bin adds its own edge type later
     *  over this same table, which is why the discriminator exists now. */
    kind: 'text-audio'
    toFileId: string
    toCellId: string
    linked: boolean
    /** `auto` = the import-time linker, `manual` = a person. Kept so a later
     *  round can offer "reset the ones nobody has touched" without guessing. */
    origin: 'auto' | 'manual'
    /** The linker's score, null for a hand edit. Diagnostic only — nothing
     *  reads it to make a decision. */
    confidence: number | null
  }
  // Measured duration for a take that predates duration capture. Fills only
  // a NULL duration_ms; a repeat delivery or a race with a real re-attach is
  // a no-op, so the event is idempotent and can never overwrite fresher data.
  'cell.audio.measure': {
    audioId: string
    durationMs: number
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
    /** Stable domain semantics may differ from the parser id (for example,
     * TMX parses with `fileType=tmx` but is a translation-memory file). */
    kind?: string
    role?: string
    bookCode?: string
    sourceFileId?: string
    anchorFileId?: string
    r2Key?: string
    importFormat?: string
    parserVersion?: string
    /** ISO codes; null/undefined when unknown at import time. */
    sourceLanguage?: string
    targetLanguage?: string
    sourceTextDirection?: 'ltr' | 'rtl'
    targetTextDirection?: 'ltr' | 'rtl'
    /** Timeline-segment-model: order lens — 'time' | 'sequence'. Stored in
     *  files.meta (JSON). Absent ⇒ client treats as 'sequence'. */
    orderedBy?: string
    /** Versioned normalized-import summary persisted under files.meta. */
    importManifest?: Record<string, unknown>
    /**
     * Sidebar folder for the file — "OT"/"NT" for scripture, or a named
     * collection such as "Treasure Hunt Bible". Stored in files.meta.
     */
    corpusMarker?: string
    /**
     * Internal re-import fold snapshot. The specialized re-import route uses
     * this to make event-log rebuilds reproduce the live merged file metadata
     * exactly. Normal genesis imports omit it.
     */
    projectionMeta?: Record<string, unknown>
  }
  // Rename a file's display label. Non-chain-mutating; parentId omitted.
  'file.rename': {
    /** New display name for the file in the project sidebar. */
    name: string
  }
  // Set/clear the file's sidebar corpus group, stored in files.meta JSON;
  // null clears it (Ungrouped). Contributor-level, like file.rename.
  'file.corpus.set': {
    corpusMarker: string | null
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
    // AQU-692: snapshot of the cell's target text at thread-creation time, so the
    // client can render the "Translation changed since this thread was created"
    // badge. Root threads only; null/absent = unknown baseline (no badge).
    createdForTranslated?: string | null
    // AQU-1233: the comment was written by a tool acting for the author, not by
    // the author typing it. Set SERVER-SIDE by the Agent API compile step only
    // (the external payload validator drops a caller-supplied value), so a
    // credential cannot post an unmarked comment. author_id stays the minting
    // user — this only changes the label reviewers read.
    viaAgent?: boolean
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

  // ── Terminology concepts (non-chain-mutating, project-level) ───────────
  // `conceptId` is client-generated (uuid) and is the projection's primary
  // key, so a replayed/duplicated create is an idempotent upsert rather than a
  // second concept.
  'term.create': {
    conceptId: string
    sourceTerm: string
    renderings: TermRenderingPayload[]
    /** 'draft' = suggested, awaiting review; 'active' = enforced immediately. */
    status: ConceptStatusPayload
    notes?: string
    caseSensitive?: boolean
    match?: TermMatchOptionsPayload
  }
  // Partial patch. Only the keys present are written — absent keys keep their
  // projected value, so two people editing DIFFERENT fields of the same
  // concept both survive. `renderings` is the one exception: it is replaced
  // wholesale, because a rendering list has no stable per-item id to merge on.
  'term.update': {
    conceptId: string
    sourceTerm?: string
    renderings?: TermRenderingPayload[]
    notes?: string
    caseSensitive?: boolean
    match?: TermMatchOptionsPayload
  }
  'term.delete': {
    conceptId: string // soft-delete: stamps deleted_at
  }
  'term.approve': {
    conceptId: string // draft -> active
  }
  'term.reject': {
    conceptId: string
    /** 'deprecate' keeps the row for the record; 'delete' soft-deletes it. */
    mode: 'delete' | 'deprecate'
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
    /**
     * AQU-538 (§3.5): target-language lane this assignment is pinned to.
     * Absent/'' = the default lane (same convention as every other lane field).
     * Stored on assignments.target_lang; omitted on the wire when ''.
     */
    targetLang?: string
    /** Optional ISO date string deadline. */
    deadline?: string | null
    /** Optional instruction note. */
    note?: string | null
  }
  'assignment.reassign': {
    assignmentId: string
    assigneeUserId: number
    /**
     * AQU-538 (§3.5): optionally re-pin the assignment to a different lane.
     * Absent (undefined) = leave the stored lane untouched — a plain reassign
     * only changes the assignee. Present (including '') = set the lane.
     */
    targetLang?: string
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
     * AQU-439: Optional camera-angle override.
     * When present, the projection also updates cells.camera_state.
     * Null clears the column; omitting this field (undefined) is a no-op.
     *
     * AQU-646 (2026-08-20): `group` joined the three original values. The
     * client's character sheets have always distinguished a group shot from a
     * mixed one; both importers used to fold it into `mixed`, so a corrected
     * sheet could never say `Group` again. The column is plain TEXT with no
     * constraint, so nothing here needed a migration.
     */
    cameraState?: 'on' | 'mixed' | 'off' | 'group' | null
    /**
     * AQU-646: the client's own line number for this row, out of her character
     * sheet's `Line #` column. The projection merges it into cells.metadata as
     * { line_number: value }, beside cast_name and under the same per-key
     * discipline. A string: it identifies a line in her production's numbering
     * rather than counting anything, and values need not be integers.
     *
     * Omitted when her sheet had no such column. Null clears it.
     */
    lineNumber?: string | null
  }

  // ── Timeline editor (non-chain-mutating) ────────────────────────────────
  // Retime a cell (move/stretch). cellId rides on the envelope; the projection
  // updates start_ms/end_ms on both the source and target rows.
  'cell.retime': {
    startMs: number
    endMs: number
  }
  // AQU-646 round 6: per-LANE presentation timing (subtitle span / target-audio
  // start), merged into the source-side cell's metadata JSONB. The frozen
  // source split (start_ms/end_ms) is untouched. Per key: number sets (absolute
  // file ms), null clears back to the default, undefined = not provided.
  'cell.lane.retime': {
    subtitleStartMs?: number | null
    subtitleEndMs?: number | null
    // Round 8: the dub anchor RELATIVE to the cell's own start, so a take moves
    // with its line. May be negative. targetStartMs is the legacy absolute form
    // — still projected so historical events replay, never written any more.
    targetOffsetMs?: number | null
    targetStartMs?: number | null
  }
  // Set/clear a file's core video URL (timeline preview master clock), stored
  // in files.meta JSON; null clears it. File-level.
  'file.video.set': {
    coreMediaUrl: string | null
  }
  // Set/clear the file's audio timing mode, stored in files.meta JSON; null
  // clears it back to the project-level default (legacy
  // ProjectWideSettings.audioTimingMode, else "dubbing").
  'file.timing.set': {
    timingMode: 'dubbing' | 'audioFirst' | null
  }
  // Stage 1: ONE track's presentation delta, merged per-field into
  // files.meta.trackOverrides[trackId]. `patch: null` deletes the entry —
  // dropping a user-added track, or resetting a default back to pure
  // defaults. Inside a patch, null means "clear THAT override" and an absent
  // key means "leave it alone"; `kind` has no null form because a track's
  // kind is its identity. The patch is FLAT on purpose — the projection
  // strips nulls recursively (see buildFileTrackSetStmt). No emitter until
  // stage 3.
  //
  // Stage 2 adds the two ADDED kinds ('folder' / 'audio'), plus `color` (a
  // palette id, never colour values) and `sourceTrackId` (which track's cells
  // an added track lines up with, set once at creation). Both new fields have a
  // null form — clearing a colour is how you go back to the default pair.
  //
  // WHICH OPERATION AN EVENT OF THIS KIND PERFORMS IS DECIDED BY ITS PATCH, and
  // that is why authorize.ts inspects the keys: a rename and a reorder are
  // maintainer work, while creating, deleting, foldering and recolouring are
  // additionally gated on the project's allowTrackEditing setting. One kind,
  // two authority levels — see track-editing-authority.ts.
  'file.track.set': {
    trackId: string
    patch: {
      kind?: 'source-subtitles' | 'source-audio' | 'target-subtitles' | 'target-audio' | 'folder' | 'audio'
      name?: string | null
      order?: number | null
      groupId?: string | null
      color?: string | null
      sourceTrackId?: string | null
    } | null
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
