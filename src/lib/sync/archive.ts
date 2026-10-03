// Client helpers for auth-worker's project archive endpoints. The archive
// ("move to Trash") action is server-authoritative for cloud-synced projects
// so all collaborators see the tombstone. Purely local projects (no server
// row) get a 404 — callers should fall through to an IDB-only tombstone.

import type { CloudFileSummary } from "./cloud-projects"
import { messageForStatus, UserError } from "../errors/user-error"
import { FRONTIER_API_URL } from "./sync-token"

export interface ArchiveSuccess {
  kind: "archived"
  archivedAt: string
  archivedBy: { id: number; username: string }
}

export interface UnarchiveSuccess {
  kind: "restored"
}

export interface ArchiveLocalOnly {
  kind: "local-only"
}

export interface ArchiveForbidden {
  kind: "forbidden"
  /** e.g. "maintainer+ required to archive a project" */
  message?: string
}

export interface ArchiveError {
  kind: "error"
  status: number
  message: string
}

export type ArchiveResult = ArchiveSuccess | ArchiveLocalOnly | ArchiveForbidden | ArchiveError
export type UnarchiveResult = UnarchiveSuccess | ArchiveLocalOnly | ArchiveForbidden | ArchiveError

export interface ProjectStateResponse {
  id: string
  name: string
  gitlabProjectId: number | null
  orgId: number | null
  /** AQU-822: the org's effective termbase-edit floor (absent on older servers). */
  termbaseEditMinRole?: number | null
  /** AQU-1086: the org's effective language-edit floor (absent on older servers). */
  languageEditMinRole?: number | null
  archivedAt: string | null
  archivedBy: { id: number; username: string } | null
  /** Active/inactive lifecycle (migration 0033). Absent = active (compat). */
  isActive?: boolean
  /**
   * AD-9: upstream source project id for linked-target projects. Null / absent
   * means self-contained (or is itself a source).
   */
  sourceProjectId?: string | null
  /** AQU-476/478: link mode — 'clone' (one-time snapshot) | 'live' (subscribed,
   *  mirrors upstream changes). Null/absent for self-contained projects. */
  sourceLinkMode?: "clone" | "live" | null
  /** AQU-476/478: which upstream lane becomes this project's source —
   *  'source' (sibling-language case) | 'target' (chain case). */
  sourceLinkConsumes?: "source" | "target" | null
  /** AQU-476/478: for target-consumption links, which upstream target state
   *  propagates — 'head' (every commit) | 'validated' (only validated heads). */
  sourceLinkGate?: "head" | "validated" | null
  /** AQU-476/478: max upstream server_seq this project has mirrored so far. */
  sourceLinkCursor?: number | null
  /** AQU-1559: the upstream file ids this link follows, or null for a
   *  whole-project link (every link made before that slice). Absent on an older
   *  server, which the Source link card reads the same way as null. */
  sourceLinkFileIds?: string[] | null
  /** AQU-1559: how many files the upstream currently holds — the M of
   *  "N of M files". Only sent for a fixed-list link; null otherwise, since a
   *  whole-project link is stated without a count. */
  sourceLinkUpstreamFileCount?: number | null
  role: { level: number; name: string; source: string }
  /** AQU-507: designated Project Manager (null = unassigned; absent = older
   *  server). Distinct from the member roster / permission ladder. */
  pm?: { id: number; username: string } | null
  /** Populated by the codex-db.files join. Optional only because old
   *  deployments may not have shipped the join yet — current servers
   *  always return at least []. */
  files?: CloudFileSummary[]
}

/**
 * AQU-820: ProjectOverview / ArchivedProjects render this string verbatim, so
 * it has to be ours. The server's `error` is untranslated and the old
 * `HTTP ${status}` fallback was a bare diagnostic; `messageForStatus` maps the
 * status to a keyed sentence and keeps the server text on `.raw` for DevTools.
 */
async function parseError(res: Response): Promise<string> {
  let raw = ""
  try {
    const body = (await res.json()) as { error?: string }
    raw = body.error ?? ""
  } catch {
    // non-JSON body — the status alone decides the message
  }
  return messageForStatus(res.status, raw, "project").message
}

export async function archiveProjectRemote(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ArchiveResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/archive`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    }
  )
  if (res.ok) {
    const body = (await res.json()) as {
      archivedAt: string
      archivedBy: { id: number; username: string }
    }
    return { kind: "archived", archivedAt: body.archivedAt, archivedBy: body.archivedBy }
  }
  if (res.status === 404) return { kind: "local-only" }
  if (res.status === 403) {
    return { kind: "forbidden", message: await parseError(res) }
  }
  return { kind: "error", status: res.status, message: await parseError(res) }
}

export async function unarchiveProjectRemote(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<UnarchiveResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/archive`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    }
  )
  if (res.ok) return { kind: "restored" }
  if (res.status === 404) return { kind: "local-only" }
  if (res.status === 403) {
    return { kind: "forbidden", message: await parseError(res) }
  }
  return { kind: "error", status: res.status, message: await parseError(res) }
}

export interface LinkProjectSourceResult {
  projectId: string
  sourceProjectId: string
  mode: "clone" | "live"
  consumes: "source" | "target"
  gate: "head" | "validated"
  previousSourceProjectId: string | null
  /** AQU-1605: the upstream lane this link consumes, as stored. Null = the
   *  upstream's former default lane, which is what every link made before that
   *  slice consumes. Absent from an older server's response. */
  laneId?: string | null
  /** AQU-476/QA-BUG-1: true if the server-side seed (clone snapshot or the
   *  first live mirror sync) actually ran. False means the caller should
   *  fall back to `triggerLinkSync` before assuming content is present —
   *  older servers that predate this field are treated as `false` (the
   *  caller's fallback then self-heals unconditionally, which is harmless:
   *  `/link/sync` no-ops for clone and re-syncing live is idempotent). */
  seeded?: boolean
}

/**
 * AQU-478: POST /api/v2/projects/:id/link-source — create a project link.
 * project_lead(500)+ on the DOWNSTREAM project (server-enforced). For
 * `mode: 'live'` the auth-worker seeds the new project via the first mirror
 * sync (AQU-476 §5) as part of this same call — files/cells arrive with
 * provenance set. Throws `UserError` on non-2xx (mirrors createCloudProject).
 */
export async function linkProjectSource(
  jwt: string,
  projectId: string,
  input: {
    sourceProjectId: string
    mode: "clone" | "live"
    consumes?: "source" | "target"
    gate?: "head" | "validated"
    /**
     * AQU-1559: the UPSTREAM file ids this link should follow. Omit to follow
     * the whole project — every file it has now and every one it gains later,
     * which is what every link did before that slice. A list makes the link a
     * fixed one: only those files mirror in, and later upstream files do not
     * arrive on their own. Never send an empty array: the server 400s it,
     * because "follow no files" is a mistake rather than a link.
     */
    fileIds?: string[]
    /**
     * AQU-1605: WHICH of the upstream's lanes this link consumes, by `lanes.id`.
     * Omit for the upstream's former default lane — what every link consumed
     * before that slice. Required in practice whenever the upstream has more
     * than one lane the user may see and `consumes` is `'target'`: the server
     * accepts the omission, but it then picks the lane for them.
     */
    laneId?: string
  },
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkProjectSourceResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(input),
    },
  )
  if (!res.ok) {
    // Actually a UserError, as the doc above promises — its message is the
    // keyed status sentence and the server body stays on `.raw`/`.cause`.
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  return (await res.json()) as LinkProjectSourceResult
}

export interface AddLinkedSourceFilesResult {
  /** The upstream file ids this request added — the requested ones the link
   *  did not already follow and the upstream still has. Empty = nothing new. */
  added: string[]
  /** The link's selection afterwards. null = it follows the whole project,
   *  which is what adding the last unlinked file makes it. */
  fileIds: string[] | null
  /** false = the addition is recorded but the files have not all arrived yet.
   *  Nothing is half-added meanwhile (the files are not part of the link until
   *  they are complete), and calling again with the same files resumes. */
  complete: boolean
}

/**
 * AQU-1560: add more of the upstream's files to this project's live link,
 * without detaching and re-linking. Each file arrives with its complete
 * current source, not only changes made from now on — the server replays its
 * upstream history before the file joins the link, and answers once that has
 * run. project_lead(500)+ on this project, server-enforced. Throws `UserError`
 * on non-2xx.
 */
export async function addLinkedSourceFiles(
  jwt: string,
  projectId: string,
  /** UPSTREAM file ids, as the link-source preview lists them. Non-empty. */
  fileIds: string[],
  apiUrl: string = FRONTIER_API_URL,
): Promise<AddLinkedSourceFilesResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/files`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ fileIds }),
    },
  )
  if (!res.ok) {
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  return (await res.json()) as AddLinkedSourceFilesResult
}

export interface LinkedSourceFileState {
  /** The upstream file ids this link follows. null = the whole project. */
  fileIds: string[] | null
  /**
   * Upstream file ids this project holds as a STOPPED copy — files the link
   * once followed and no longer does, still here with the source text they had
   * when they were stopped and every translation on them. Always empty on a
   * whole-project link, which has stopped nothing.
   *
   * Why the client needs it: a stopped file and a file this project never had
   * both read as an unchecked row, but checking them does different things —
   * following a stopped file again REPLACES its source text with the upstream's
   * current text, where checking a never-had file only brings one in. The
   * confirm has to say which.
   */
  stoppedFileIds: string[]
}

/**
 * AQU-1562: what this project's live link follows, and which of the upstream's
 * other files are here as stopped copies. project_lead(500)+, server-enforced.
 * Throws `UserError` on non-2xx.
 */
export async function loadLinkedSourceFileState(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkedSourceFileState> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/files`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) {
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  const body = (await res.json()) as Partial<LinkedSourceFileState>
  return {
    fileIds: Array.isArray(body.fileIds) ? body.fileIds : null,
    // An older server that does not answer this reads as "nothing stopped",
    // which is what every link looked like before this slice.
    stoppedFileIds: Array.isArray(body.stoppedFileIds) ? body.stoppedFileIds : [],
  }
}

export interface StopLinkedSourceFilesResult {
  /** The upstream file ids this request stopped — the requested ones the link
   *  was actually following. Empty = nothing was being followed, so a no-op. */
  stopped: string[]
  /** The link's selection afterwards. Never null: stopping every file is
   *  refused, so a link that was following the whole project comes back as the
   *  fixed list of the rest (AQU-1559's rule). */
  fileIds: string[] | null
  /** Whether the link followed the whole project before this call — i.e.
   *  whether it has just become a fixed list. */
  wasWholeProject: boolean
}

/**
 * AQU-1562: stop this project following some of the upstream's files, keeping
 * them as the project's own copies.
 *
 * Nothing is deleted or moved: each file stays with the source text it has now
 * and every translation, validation and comment on it, and only stops receiving
 * upstream changes. Other followed files are unaffected. At least one file must
 * stay linked — stopping all of them is "Detach from source", and the server
 * answers 409 rather than leaving a link that can never sync.
 *
 * project_lead(500)+, server-enforced. Throws `UserError` on non-2xx.
 */
export async function stopLinkedSourceFiles(
  jwt: string,
  projectId: string,
  /** UPSTREAM file ids, as the link-source preview lists them. Non-empty. */
  fileIds: string[],
  apiUrl: string = FRONTIER_API_URL,
): Promise<StopLinkedSourceFilesResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/files/stop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ fileIds }),
    },
  )
  if (!res.ok) {
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  return (await res.json()) as StopLinkedSourceFilesResult
}

/**
 * AQU-476/QA-BUG-1: client-side seed self-heal for `mode: 'live'` links.
 * `linkProjectSource` already triggers this server-side and awaits it — this
 * is the fallback for when that trigger reports `seeded: false` (sync-worker
 * unreachable, config drift, etc.) or when it's called from a project-open
 * path where the project has 0 files (see `ProjectWorkspace`'s zero-file
 * self-heal). Mints a `__project__`-scoped sync-token (the established
 * sentinel for project-level, non-file-scoped calls — see
 * useComments/useProjectHealth/outbox-flush) rather than requiring an open
 * file, since a freshly linked project may have none yet.
 *
 * Best-effort: swallows errors (returns false) — staleness/self-heal is a
 * soft signal, never something that should block navigation into the project.
 *
 * AQU-1544: "best-effort" describes the CALL, not what callers may do with
 * its answer. The link flows used to await this and drop the result, which
 * is how a failed first sync came to be reported as a finished link.
 */
export async function triggerLinkSync(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<boolean> {
  return (await runLinkSync(jwt, projectId, apiUrl)).ok
}

export type LinkSyncOutcome =
  | { ok: false }
  /** `ranSync` is the sync engine's own answer: false means it had nothing to
   *  do — the link is already current, or the upstream has nothing to give. */
  | { ok: true; ranSync: boolean }

/**
 * AQU-1544: `triggerLinkSync` for a caller that has to tell "the sync worked
 * and brought content in" from "the sync worked and there was nothing to
 * bring" — Project Settings' "Sync now" on a never-synced link, where the
 * second is an empty upstream and must not be reported as either a failure or
 * an arrival. Same request, same never-throws contract.
 */
export async function runLinkSync(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkSyncOutcome> {
  try {
    const tokenRes = await fetch(`${apiUrl}/api/v2/sync-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ projectId, fileId: "__project__" }),
    })
    if (!tokenRes.ok) return { ok: false }
    const { token } = (await tokenRes.json()) as { token: string }

    const { syncWorkerHttpOrigin } = await import("./sync-worker-url")
    const syncRes = await fetch(
      `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/link/sync`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    )
    if (!syncRes.ok) return { ok: false }
    const body = (await syncRes.json().catch(() => null)) as { ranSync?: unknown } | null
    return { ok: true, ranSync: body?.ranSync === true }
  } catch {
    return { ok: false }
  }
}

/** Fetches server state for a project, including archive metadata and the
 * caller's role. Returns null for 404 / 403 (the Dashboard treats those as
 * "no server row" and falls back to local state). */
export async function fetchProjectState(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ProjectStateResponse | null> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    }
  )
  if (!res.ok) return null
  return (await res.json()) as ProjectStateResponse
}
