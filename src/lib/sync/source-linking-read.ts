// Typed fetch wrappers for auth-worker source-linking endpoints (Phase 5
// / AD-9). Server routes live in `auth-worker/src/routes/source-linking.ts`.
//
// Pattern follows `cells-read.ts` (Phase 2a) and `projects-read.ts`:
// callers pass an authoritative JWT; failures throw `SourceLinkingError`
// with the HTTP status and the response body (truncated).
//
// The endpoint set:
//
//   POST   /api/v2/projects/:id/link-source        link to upstream
//   POST   /api/v2/projects/:id/detach-source      clear upstream + snapshot
//   GET    /api/v2/projects/:id/downstreams        list linked-target ids
//
// We don't expose `DELETE /api/v2/projects/:id` here — it's owner-only
// hard-delete and the rest of the surface (Trash) handles project-record
// disposal through the archive flow. Phase 1C only added it to the
// auth-worker so a future "destroy from Trash" UI has a single endpoint;
// no current Phase 5 component needs to call it.

import { AUTH_API_URL } from "./sync-token"
import type {
  DetachResult,
  DownstreamProject,
  LinkResult,
} from "./source-linking-read-types"

export class SourceLinkingError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`source-linking failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "SourceLinkingError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new SourceLinkingError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  }
}

/**
 * GET /api/v2/projects/:id/downstreams
 *
 * Returns the projects whose `source_project_id` points at `projectId`.
 * Used by:
 *   - the source-only / upstream project's settings panel (to show
 *     "X linked targets currently read from this project");
 *   - the archive / delete confirmation flow (so the actor sees what
 *     they're about to affect downstream).
 *
 * The server response carries an explicit `{ projectId, downstreams }`
 * shape; we flatten to just the array here because callers don't use
 * the echo'd id.
 */
export async function fetchProjectDownstreams(
  projectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<DownstreamProject[]> {
  const url = `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/downstreams`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<{
    projectId: string
    downstreams: Array<string | DownstreamProject>
  }>(res)
  // The server currently returns an array of bare ids (strings). Future
  // enrichment (returning {id, name}) is forward-compat: we accept either
  // form here.
  return (body.downstreams ?? []).map((d) =>
    typeof d === "string" ? { id: d } : d,
  )
}

/**
 * POST /api/v2/projects/:id/link-source
 *
 * Sets `projects.source_project_id` to `sourceProjectId`. Server-side
 * enforces:
 *   - role >= project_lead (500)
 *   - no self-link (sourceProjectId !== projectId)
 *   - cycle detection (the new source must not be downstream of this
 *     project, directly or transitively)
 *
 * Cycle and not-found errors come back as 409 / 404 respectively;
 * callers catch SourceLinkingError and surface the message body.
 */
export async function linkProjectToSource(
  projectId: string,
  sourceProjectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<LinkResult> {
  const url = `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source`
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ sourceProjectId }),
  })
  return await readJson<LinkResult>(res)
}

/**
 * POST /api/v2/projects/:id/detach-source
 *
 * Clears `projects.source_project_id`, emits a `project.link-source`
 * event with a null payload, and bursts `source.cell.commit` events
 * snapshotting the upstream's current source cells into the detaching
 * project's own source side. After this, the project is self-contained
 * — upstream edits no longer flow.
 *
 * Returns the count of snapshotted cells so the UI can confirm what
 * happened ("Snapshotted 31,102 source cells into this project").
 */
export async function detachProjectFromSource(
  projectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<DetachResult> {
  const url = `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/detach-source`
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(jwt),
  })
  return await readJson<DetachResult>(res)
}
