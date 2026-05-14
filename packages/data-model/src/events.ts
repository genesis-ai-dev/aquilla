// Event grammar types — AD-2 + AD-9 (spec 03-data-model.md).
//
// Mirror of `sync-worker/src/events/types.ts`; this package is the canonical
// shared definition that every app and the web client consume. The Worker
// vendors its own copy (Workers can't import workspace packages directly at
// runtime in CF Workers' build model) — keep them in lockstep.

export type EventKind =
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
  // Validation (reviewer-level).
  | "cell.validate"
  | "cell.unvalidate"
  // File lifecycle.
  | "file.create"

export interface EventPayloads {
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
     * UUIDv7 of the source row's `event_id` as observed by the editor at
     * commit time. Null for target-owned cells with no source counterpart.
     * Powers AD-9 staleness derivation:
     *   source_cell.event_id != target_cell.source_event_id ⇒ stale.
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
    /** The target commit event whose validation is being withdrawn. */
    editEventId: string
  }

  "file.create": {
    name: string
    /** "codex" | "vtt" | "srt" | etc. — matches files.file_type. */
    fileType: string
    sourceLanguage?: string
    targetLanguage?: string
  }
}

export type PayloadFor<K extends EventKind> = EventPayloads[K]

/**
 * Raw event as authored by the client, before server-side authorization.
 *
 * `parentId` is REQUIRED for every chain-mutating kind except the genesis
 * `*.create` kinds (where it must be null). The server's projection enforces
 * AD-2's first-child-of-parent rule using this column.
 */
export interface RawEvent<K extends EventKind = EventKind> {
  /** Client-generated UUIDv7. Idempotency key on INSERT OR IGNORE. */
  id: string
  /** Bump when an existing payload shape changes; additive optional fields don't. */
  schemaVersion: number
  kind: K
  projectId: string
  /** Omitted for project-level events. */
  fileId?: string
  /** Omitted for file-level events. */
  cellId?: string
  /**
   * Prior winning event on this cell's chain. Null only for genesis events
   * (`source.cell.create` / `target.cell.create`). Required otherwise.
   */
  parentId?: string | null
  /** Frontier username. Server validates against the JWT. */
  author: string
  payload: PayloadFor<K>
  /** Milliseconds since epoch. Server clock is canonical for ordering. */
  clientTs: number
}

/**
 * JWT claims for `aud=sync` tokens. Used by the per-project DO + read routes
 * to authorize event writes and projection reads.
 */
export interface EventClaims {
  userId: number
  username: string
  projectId: string
  /** When token is scoped to a single file (legacy /sync-token mints these). */
  fileId?: string
  /** Numeric role level (100=viewer..700=owner). */
  roleLevel: number
}

/**
 * The set of event kinds that update the AD-2 chain head on `cells.event_id`.
 * Used by the projection's parent-chain guard. Excludes validation kinds
 * (which update `cell_validators` but not `cells.event_id`) and `file.create`
 * (which seeds `files`, not `cells`).
 */
export const CHAIN_MUTATING_KINDS: ReadonlySet<EventKind> = new Set([
  "source.cell.create",
  "source.cell.commit",
  "source.cell.delete",
  "source.cell.reorder",
  "target.cell.create",
  "target.cell.commit",
  "target.cell.delete",
  "target.cell.reorder",
])
