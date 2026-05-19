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
  // Validation-driven decay endorsements (server-emitted by sync-worker).
  | 'cell.endorsement'
  | 'cell.endorsement.revoke'
  // File lifecycle.
  | 'file.create'
  // Project lifecycle.
  | 'project.link-source'

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
  }
  'cell.endorsement': {
    endorsedCellId: string
    endorsingCellId: string
    validatorUserId: number
    retrievalQueryEventId: string
  }
  'cell.endorsement.revoke': {
    endorsementEventId: string
  }

  // ── File lifecycle ─────────────────────────────────────────────────────
  //
  // Spec §"File" (03-data-model.md) reshapes the file.create payload to
  // carry role/kind/book_code/source_file_id/anchor_file_id/r2_key/
  // import_format/parser_version. The legacy `fileType` field is kept so
  // older clients continue to author valid events; the projection writes
  // both `role` (preferred) and `file_type` (legacy column) to the
  // `files` row.
  'file.create': {
    /** Display name for the file in the project sidebar. */
    name: string
    /** Legacy: "codex" | "vtt" | "srt" | etc. — pre-spec column on files. */
    fileType?: string
    /** Spec semantic side: 'source' | 'target' | 'dictionary' | 'translationNotes'. */
    role?: string
    /** Spec file shape: 'codex' | 'usfm' | 'docx' | 'pptx' | 'vtt' | 'srt' | 'txt' | 'md'. */
    kind?: string
    /** Scripture book code ('GEN', 'EXO', ...). Null for non-scripture. */
    bookCode?: string
    /** File-level pairing — the upstream source file this target file pairs with. */
    sourceFileId?: string
    /** Ordering anchor for the file's position in the project file browser. */
    anchorFileId?: string
    /** R2 key for the original imported blob (AD-4). Null for non-imported files. */
    r2Key?: string
    /** Format the original blob was parsed as ('usfm', 'docx', ...). */
    importFormat?: string
    /** Parser revision that produced this file's cells; enables re-parse. */
    parserVersion?: string
    /** ISO codes; null/undefined when unknown at import time. */
    sourceLanguage?: string
    targetLanguage?: string
  }
  'project.link-source': {
    sourceProjectId: string | null
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
}
