// Types for the auth-worker source-linking API (Phase 5 / AD-9).
//
// Mirrors `auth-worker/src/routes/source-linking.ts`. Only describes the
// fields the client surfaces — the server response includes a few extras
// that aren't user-visible (`previousSourceProjectId` on link, audit-ish
// metadata) which we discard.

/**
 * A downstream project — i.e. one whose `source_project_id` points at the
 * subject. Returned by GET /:projectId/downstreams.
 *
 * Phase 1C currently returns just the project id; the shape allows for a
 * future server-side enrichment (project name, archive state) without
 * changing this file's exports.
 */
export interface DownstreamProject {
  /** The downstream project's id. */
  id: string
  /** Optional display name; populated when the server can resolve it. */
  name?: string
}

/** Response of POST /:projectId/detach-source. */
export interface DetachResult {
  projectId: string
  previousSourceProjectId: string
  /** How many `source.cell.commit` events the burst emitted. May be 0
   *  when the upstream had no source-side cells yet — that's still a
   *  successful detach. */
  snapshottedCellCount: number
}

/** Response of POST /:projectId/link-source. */
export interface LinkResult {
  projectId: string
  sourceProjectId: string
  previousSourceProjectId: string | null
}

/**
 * Combined view of "is this project linked to a source, and what is it"
 * — derived client-side from the project record. We don't have a single
 * endpoint that returns this exact shape, so the hook layer composes it
 * from the project list / project detail responses.
 */
export interface ProjectSourceInfo {
  /** The upstream project id, or null when this project is unlinked. */
  sourceProjectId: string | null
  /** Friendly name if the client could resolve it from accessible projects. */
  sourceProjectName?: string
}
