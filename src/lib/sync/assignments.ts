// Client for the assignment.* feature (Phase C, slice 1).
//
// Two reads against the auth-worker (manager workload + assignee inbox) and one
// write. Unlike cell edits — which queue in the outbox and flush in the editor
// — assigning work is a deliberate, low-frequency manager action made from the
// oversight pages (where no outbox flusher is mounted). So createAssignment
// POSTs the assignment.create event to the sync-worker directly and awaits
// server acceptance, giving immediate feedback; the caller then refreshes.

import { FRONTIER_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"
import { UserError } from "@/lib/errors/user-error"
import { v7 as uuidv7 } from "uuid"
import { buildRawEvent } from "./events-emit"
import { fetchSyncToken } from "./sync-token"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

/** Per-assignee rollup for the manager workload view (mirrors the server). */
export interface AssigneeWorkload {
  userId: number
  username: string | null
  openAssignments: number
  cellsTotal: number
  cellsDone: number
}

/**
 * One open assignment in the org-wide "Team workload" view, with its project
 * attribution (mirrors OrgAssignmentRow on the server — AQU-494). `fileId` is
 * one of the assignment's resolved cells' files, used to route an unassign
 * event's sync-token request; null only if the scope resolved to zero cells.
 */
export interface OrgWorkloadAssignment {
  assignmentId: string
  projectId: string
  projectName: string
  fileId: string | null
  assigneeUserId: number
  username: string | null
  scopeLabel: string
  cellsTotal: number
  cellsDone: number
  deadline: string | null
}

/** A single open assignment in the caller's inbox (mirrors the server). */
export interface MyAssignment {
  assignmentId: string
  projectId: string
  scopeKind: string
  scopeLabel: string
  deadline: string | null
  note: string | null
  cellsTotal: number
  cellsDone: number
  createdAt: number
}

/**
 * Manager view: every open assignment across the org's active projects, with
 * project + derived progress attribution (maintainer+). One row per
 * assignment — AQU-494: a per-assignee aggregate couldn't say which project
 * an assignment belonged to.
 */
export async function getWorkload(jwt: string, orgId: number): Promise<OrgWorkloadAssignment[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/assignments/workload`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { assignments: OrgWorkloadAssignment[] }).assignments
}

/** Assignee inbox: the caller's open assignments in one project (any member). */
export async function getMyAssignments(jwt: string, projectId: string): Promise<MyAssignment[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/assignments/mine`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "project")
  return ((await res.json()) as { assignments: MyAssignment[] }).assignments
}

/** An inbox assignment with its project name, from the org-wide read. */
export interface MyOrgAssignment extends MyAssignment {
  projectName: string
}

/**
 * Assignee inbox across a whole org in ONE request — the caller's open
 * assignments over all the org's active projects. Replaces the per-project
 * fan-out (one request per project). Any org member.
 */
export async function getMyAssignmentsForOrg(jwt: string, orgId: number): Promise<MyOrgAssignment[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/assignments/mine`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { assignments: MyOrgAssignment[] }).assignments
}

/**
 * Manager view: per-assignee open workload + derived progress for ONE project
 * (maintainer+). Returns the same AssigneeWorkload shape as getWorkload() so
 * the Team card can reuse the same rendering.
 *
 * AQU-495: every caller of this function MUST re-invoke it (or otherwise
 * revalidate its own list state) after createAssignment()/unassignAssignment()
 * resolve — this is a plain-fetch AD-3 read, not subscribed to anything, so a
 * stale caller shows "no open assignments" until a manual page reload.
 * SWARM-TODO(AQU-495): ProjectOverview.tsx's "Team" card (org/ProjectOverview.tsx,
 * ~line 1177) wires `<AssignWork onAssigned={loadRow} />`, but `loadRow` only
 * re-fetches the org portfolio (`getPortfolio` → `setAudio`) — it never calls
 * `getProjectAssignments(jwt, id).then(setWorkload)`. That file is out of this
 * worktree's ownership (Lane B), so this is flagged rather than fixed here;
 * the one-line fix is to also re-run the `getProjectAssignments` effect (or
 * extract it into a `loadWorkload` callback and call both) from `onAssigned`.
 */
export async function getProjectAssignments(
  jwt: string,
  projectId: string,
): Promise<AssigneeWorkload[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/assignments/all`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "project")
  return ((await res.json()) as { roster: AssigneeWorkload[] }).roster
}

/**
 * Distinct chapters in a file (for the assign picker's chapter dropdown).
 * Natural-sorted server-side; each value feeds createAssignment's
 * `scope[].chapter` (→ resolver LIKE 'GEN 1:%') directly. Any project member.
 */
export async function getFileChapters(jwt: string, projectId: string, fileId: string): Promise<string[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/chapters`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "project")
  return ((await res.json()) as { chapters: string[] }).chapters
}

export class AssignmentEmitError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "AssignmentEmitError"
    this.status = status
  }
}

/**
 * POST one already-built assignment.* event to the sync-worker, mint its
 * sync token, and await server acceptance. Shared by createAssignment and
 * unassignAssignment. Throws AssignmentEmitError on transport failure or
 * server rejection (e.g. role too low → 403, surfaced from `rejected`).
 */
async function postAssignmentEvent(
  jwt: string,
  projectId: string,
  fileId: string,
  event: ReturnType<typeof buildRawEvent>,
): Promise<void> {
  const { token } = await fetchSyncToken(jwt, projectId, fileId)
  let res: Response
  try {
    res = await fetch(`${syncWorkerHttpOrigin()}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [event] }),
    })
  } catch (err) {
    throw new AssignmentEmitError(err instanceof Error ? err.message : "network error")
  }
  if (!res.ok) {
    throw new AssignmentEmitError(`Request failed (HTTP ${res.status})`, res.status)
  }
  const body = (await res.json().catch(() => null)) as {
    accepted?: Array<{ id: string }>
    rejected?: Array<{ id: string; status: number; reason: string }>
  } | null
  const rejected = body?.rejected ?? []
  if (rejected.length > 0) {
    throw new AssignmentEmitError(rejected[0].reason || "event rejected", rejected[0].status)
  }
  if (!(body?.accepted ?? []).some((a) => a.id === event.id)) {
    throw new AssignmentEmitError("event was not accepted by the server")
  }
}

export interface CreateAssignmentArgs {
  jwt: string
  projectId: string
  /** Any project file — the event is routed through this file's sync token
   *  (project-level semantics live in the scope payload). */
  fileId: string
  /** The manager's username (stamped as the event author; server re-verifies). */
  author: string
  assigneeUserId: number
  /** One book (fileId only) or chapter (fileId + "BOOK CH") per entry. */
  scope: { fileId: string; chapter?: string }[]
  scopeKind: "books" | "chapters"
  scopeLabel: string
  deadline?: string | null
  note?: string | null
}

/**
 * Emit one `assignment.create` event to the sync-worker and await acceptance.
 * Returns the new assignmentId. Throws AssignmentEmitError on transport failure
 * or server rejection (e.g. role too low → 403, surfaced from `rejected`).
 */
export async function createAssignment(args: CreateAssignmentArgs): Promise<string> {
  const assignmentId = uuidv7()
  const event = buildRawEvent({
    kind: "assignment.create",
    projectId: args.projectId,
    fileId: args.fileId,
    parentId: null,
    author: args.author,
    payload: {
      assignmentId,
      scopeKind: args.scopeKind,
      scope: args.scope,
      scopeLabel: args.scopeLabel,
      assigneeUserId: args.assigneeUserId,
      ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    },
  })

  await postAssignmentEvent(args.jwt, args.projectId, args.fileId, event)
  return assignmentId
}

export interface UnassignAssignmentArgs {
  jwt: string
  projectId: string
  /** A file within the project — routes the sync token (project-level
   *  semantics live in the payload, same convention as createAssignment). */
  fileId: string
  /** The caller's username (stamped as the event author; server re-verifies). */
  author: string
  assignmentId: string
}

/**
 * Emit one `assignment.unassign` event to soft-close an assignment (AQU-494:
 * "remove"/"clear" an assignment from the team-workload view). Works
 * regardless of the assignment's progress — completed or not, this just sets
 * `unassigned_at` server-side; it never touches assignment_cells or the
 * underlying cells, so validated work is untouched. Awaits server acceptance;
 * throws AssignmentEmitError on transport failure or rejection (e.g. role too
 * low → 403).
 */
export async function unassignAssignment(args: UnassignAssignmentArgs): Promise<void> {
  const event = buildRawEvent({
    kind: "assignment.unassign",
    projectId: args.projectId,
    fileId: args.fileId,
    parentId: null,
    author: args.author,
    payload: { assignmentId: args.assignmentId },
  })
  await postAssignmentEvent(args.jwt, args.projectId, args.fileId, event)
}
