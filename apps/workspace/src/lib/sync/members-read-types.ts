// Types for the frontier-server project-members read API (Phase 2b).
//
// Mirror of `apps/frontier-server/src/routes/projects.ts` GET /api/v2/projects/:id/members.

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
