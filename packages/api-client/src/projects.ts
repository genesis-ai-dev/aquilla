// Typed fetch wrappers for the project endpoints (read side).
//
// Copied from `src/lib/sync/projects-read.ts` (Phase 2b). Behavior unchanged:
// throws on non-2xx, returns the parsed body on success. No React Query, no
// caching layer. Apps wire it through vanilla useState + race-guarded effects.
//
// Endpoints (currently served by codex-auth-worker; 3e relocates to
// apps/frontier-server/):
//   GET  /api/v2/projects
//   GET  /api/v2/projects/:projectId
//   POST /api/v2/projects                  (create)
//   PATCH /api/v2/projects/:projectId      (rename / set source link)
//   DELETE /api/v2/projects/:projectId     (archive / tombstone)

import { AUTH_API_URL } from "./config"

export interface ProjectFileSummary {
  id: string
  name: string
  type: string
  cellCount: number
}

export interface ProjectMemberRoleSource {
  level: number
  name: string
  /** "override" (explicit project_members) | "creator" | "org" (org_members) | "gitlab" (legacy). */
  source: string
}

export interface ProjectDetailResponse {
  id: string
  name: string
  archivedAt: string | null
  archivedBy: { id: number; username: string } | null
  role: ProjectMemberRoleSource
  files: ProjectFileSummary[]
}

export interface ProjectListItem {
  id: string
  name: string
  role: ProjectMemberRoleSource
  files: ProjectFileSummary[]
}

export interface ProjectListResponse {
  projects: ProjectListItem[]
}

export class ProjectsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`projects api failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "ProjectsReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new ProjectsReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

export async function fetchProject(
  projectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<ProjectDetailResponse> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}`,
    { headers: authHeaders(jwt) },
  )
  return await readJson<ProjectDetailResponse>(res)
}

export async function fetchProjectList(
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<ProjectListItem[]> {
  const res = await fetch(`${apiUrl}/api/v2/projects`, {
    headers: authHeaders(jwt),
  })
  const body = await readJson<ProjectListResponse>(res)
  return body.projects
}

/** Alias used by callers reading directly off the spec. Same semantics as
 *  fetchProjectList; the server only returns rows the caller can access. */
export async function fetchAccessibleProjects(
  jwt: string,
  apiUrl?: string,
): Promise<ProjectListItem[]> {
  return await fetchProjectList(jwt, apiUrl)
}
