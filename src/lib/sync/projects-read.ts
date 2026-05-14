// Typed fetch wrappers for auth-worker project read endpoints (Phase 2b).
//
// Pattern follows `cells-read.ts` (Phase 2a): an authoritative JWT is passed
// in by the caller; failures throw `ProjectsReadError` with the HTTP status
// and body.
//
// The auth-worker also hosts the older legacy wrappers in
// `src/lib/sync/cloud-projects.ts` and `src/lib/frontier/*` — those return
// null on 403/404 rather than throwing. We keep them as-is for callers that
// rely on the silent-failure semantics; this file is for the strict variant
// the new hooks consume.

import { AUTH_API_URL } from "./sync-token"
import type {
  ProjectDetailResponse,
  ProjectListResponse,
  ProjectListItem,
} from "./projects-read-types"

export class ProjectsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`projects-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
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

/**
 * GET /api/v2/projects/:projectId — full project record + role + file list.
 *
 * Throws on non-2xx. 403 means "no access"; 404 means "doesn't exist".
 * Hooks typically map both to a friendly "project not found" state.
 */
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

/**
 * GET /api/v2/projects — every accessible (non-archived) project for the
 * caller. Used by the dashboard listing.
 */
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

/**
 * Alias of {@link fetchProjectList}. Kept under the spec-named export so
 * callers reading the spec map straight to the right wrapper. Server-side,
 * "accessible" === "listed by GET /projects" — auth-worker filters by
 * project_members / org_members / creator on the calling user.
 */
export async function fetchAccessibleProjects(
  jwt: string,
  apiUrl?: string,
): Promise<ProjectListItem[]> {
  return await fetchProjectList(jwt, apiUrl)
}
