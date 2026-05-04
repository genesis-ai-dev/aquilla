// Discriminated union of all known event kinds. Adding a new kind requires
// adding a payload type to EventPayloads AND a role to REQUIRED_ROLE in
// role-policy.ts (TypeScript's exhaustiveness check enforces both).
export type EventKind =
  | 'cell.commit'
  | 'cell.validate'
  | 'cell.unvalidate'
  | 'thread.add'
  | 'thread.resolve'
  | 'cell.metadata.set'

// Payload shape per event kind. Using an interface (not Record) so that
// EventPayloads[K] gives type-safe lookups without `as` casts.
export interface EventPayloads {
  'cell.commit': {
    /** Plain text after commit. */
    value: string
    /** HTML-serialized rich text after commit. */
    valueHtml: string
    /** ID of the previous cell.commit event for this cell, if any. */
    prevEventId?: string
  }
  'cell.validate': {
    /** The cell.commit event being validated. */
    editEventId: string
  }
  'cell.unvalidate': {
    /** The cell.commit event whose validation is being withdrawn. */
    editEventId: string
  }
  'thread.add': {
    threadId: string
    content: string
    /** Parent thread for replies; absent for new threads. */
    parentThreadId?: string
  }
  'thread.resolve': {
    threadId: string
  }
  'cell.metadata.set': {
    /** Field name on the cell projection (e.g. 'cellLabel', 'sourceLocation'). */
    field: string
    value: unknown
  }
}

export type PayloadFor<K extends EventKind> = EventPayloads[K]

// Raw event as received from the client (before authorization).
export interface RawEvent<K extends EventKind = EventKind> {
  id: string                  // client-generated UUIDv7
  schemaVersion: number       // bump when an existing payload shape changes; additive optional fields don't require a bump
  kind: K
  projectId: string
  fileId?: string             // omitted for project-level events
  cellId?: string             // omitted for file-level events
  author: string              // frontier username (server validates against JWT)
  payload: PayloadFor<K>
  clientTs: number            // ms since epoch; used for LWW conflict resolution — server clock (not exposed here) is the canonical ordering key
}

// JWT claims stamped on every authorized event. The sync-worker's existing
// auth.ts already mints similar claims for WS upgrades; this is the
// event-write equivalent.
export interface EventClaims {
  userId: number
  username: string
  projectId: string
  fileId?: string             // when token is scoped to a single file
  /** Numeric role level (100=viewer..700=owner). Mapped from SyncTokenClaims.role; renamed from "role" for clarity — this is the level, not a role name. */
  roleLevel: number
}
