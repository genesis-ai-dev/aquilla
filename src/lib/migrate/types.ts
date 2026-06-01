// Shared types for the legacy-Codex → Aquilla migration engine.

/** A fully-formed event envelope produced by the engine, matching the
 *  POST /migrate/ingest contract on the sync worker. `id`, `author`, and
 *  `clientTs` are authoritative (deterministic id, original author, legacy
 *  timestamp) — that is what the trusted endpoint preserves. */
export interface IngestEvent {
  id: string
  kind: string
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: Record<string, unknown>
}
