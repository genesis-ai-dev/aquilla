// Typed fetch wrappers for project-members endpoints.
//
// Mirrors `src/lib/sync/members-read.ts`. Strict-failure (non-2xx → throw).

import { AUTH_API_URL } from "./config"

export interface ProjectMemberRole {
  level: number
  name: string
  /** "override" | "creator" | "org" | "gitlab". */
  source: string
}

export interface ProjectMember {
  userId: number
  username: string
  role: ProjectMemberRole
}

export interface ProjectMembersResponse {
  members: ProjectMember[]
}

export class MembersReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`members api failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "MembersReadError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new MembersReadError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

export async function fetchProjectMembers(
  projectId: string,
  jwt: string,
  apiUrl: string = AUTH_API_URL,
): Promise<ProjectMember[]> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    { headers: authHeaders(jwt) },
  )
  const body = await readJson<ProjectMembersResponse>(res)
  return body.members
}
