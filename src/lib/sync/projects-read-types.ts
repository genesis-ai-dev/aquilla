// Types for the auth-worker project read API (Phase 2b).
//
// Mirror of `auth-worker/src/routes/projects.ts` GET /api/v2/projects and
// GET /api/v2/projects/:projectId.

export interface ProjectFileSummary {
  id: string
  name: string
  type: string
  cellCount: number
  /** AQU-1596: what the file's header claimed at import. Import information,
   *  never a lane's language — it can disagree with the lane the rows live in.
   *  A language shown to a user comes off the lane, not off here. */
  declaredSourceLanguage?: string | null
  declaredTargetLanguage?: string | null
  sourceTextDirection?: "ltr" | "rtl" | null
  targetTextDirection?: "ltr" | "rtl" | null
}

export interface ProjectMemberRoleSource {
  level: number
  name: string
  /** "override" (explicit project_members) | "group" (group_project_grants) | "org" (org_members) | "creator". See AD-12. */
  source: string
}

export interface ProjectRecord {
  id: string
  name: string
  /** ISO timestamp; null when the project is active. */
  archivedAt: string | null
  archivedBy: { id: number; username: string } | null
  role: ProjectMemberRoleSource
  files: ProjectFileSummary[]
}

/** Single-project (GET /api/v2/projects/:id) response shape. */
export type ProjectDetailResponse = ProjectRecord

/** List shape returned from GET /api/v2/projects — `archivedAt` is absent on
 *  the list endpoint (always non-archived) and `files` may be empty until
 *  the projection rolls up. */
export interface ProjectListItem {
  id: string
  name: string
  role: ProjectMemberRoleSource
  files: ProjectFileSummary[]
}

export interface ProjectListResponse {
  projects: ProjectListItem[]
}
