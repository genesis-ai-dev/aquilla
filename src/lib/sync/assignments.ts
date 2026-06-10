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

/** Manager view: per-assignee open workload + derived progress (maintainer+). */
export async function getWorkload(jwt: string, orgId: number): Promise<AssigneeWorkload[]> {
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/assignments/workload`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { workload: AssigneeWorkload[] }).workload
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

  const { token } = await fetchSyncToken(args.jwt, args.projectId, args.fileId)
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
    throw new AssignmentEmitError(`Assign failed (HTTP ${res.status})`, res.status)
  }
  const body = (await res.json().catch(() => null)) as {
    accepted?: Array<{ id: string }>
    rejected?: Array<{ id: string; status: number; reason: string }>
  } | null
  const rejected = body?.rejected ?? []
  if (rejected.length > 0) {
    throw new AssignmentEmitError(rejected[0].reason || "assignment rejected", rejected[0].status)
  }
  if (!(body?.accepted ?? []).some((a) => a.id === event.id)) {
    throw new AssignmentEmitError("assignment was not accepted by the server")
  }
  return assignmentId
}
