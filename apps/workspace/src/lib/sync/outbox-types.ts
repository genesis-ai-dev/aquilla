/**
 * Client-side mirror of the sync-worker's AD-2 event grammar
 * (`apps/sync/src/events/types.ts`). Keep field names aligned with the
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
 *
 * v1.x event kinds (comments, threads, waivers, validation grammar
 * extensions) are NOT in scope here — they remain stubbed per 2b.
 */

// ── Kind union (must mirror apps/sync/src/events/types.ts) ──────────────

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
  // File lifecycle.
  | "file.create"

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

  "file.create": {
    name: string
    /** Legacy alias for `kind`; kept until every emitter moves to role+kind. */
    fileType?: string
    /** Spec §"File" semantic side: 'source' | 'target' | 'dictionary' | 'translationNotes'. */
    role?: string
    /** Spec §"File" shape: 'codex' | 'usfm' | 'docx' | 'pptx' | 'vtt' | 'srt' | 'txt' | 'md'. */
    kind?: string
    bookCode?: string
    sourceFileId?: string
    anchorFileId?: string
    r2Key?: string
    importFormat?: string
    parserVersion?: string
    sourceLanguage?: string
    targetLanguage?: string
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
