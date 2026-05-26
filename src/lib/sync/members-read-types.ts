// Types for the auth-worker project-members read API (Phase 2b).
//
// Mirror of `auth-worker/src/routes/projects.ts` GET /api/v2/projects/:id/members.

export interface ProjectMemberRole {
  level: number
  name: string
  /** "override" | "group" | "creator" | "org". See AD-12 in project-permissions.ts. */
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
