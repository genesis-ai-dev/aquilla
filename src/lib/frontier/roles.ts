/**
 * Codex's CF-native numeric role ladder. Single source of truth for the
 * 7-level scheme used across InviteStep, SharePanel, MembersPage, and the
 * frontier-server (mirrored in
 * `frontier-server/cloudflare/src/services/project-permissions.ts` —
 * see migration 0013).
 *
 * The ladder is intentionally richer than GitLab's 5 rungs (10/20/30/40/50)
 * so we can represent translation-domain distinctions:
 *
 *   - reviewer (300): read + comment + validate cells, no content edits
 *     (translation consultants approving work without changing it)
 *   - project_lead (500): contributor + manage members, but not manage roles
 *     (operational PMs at project scope)
 *
 * GitLab pass-through for legacy desktop-app users is handled server-side
 * in `accessLevelToRoleLevel`. Clients must not re-derive that mapping;
 * the server returns `role.level` already collapsed onto this ladder.
 */
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

export type RoleLevel = (typeof ROLE)[keyof typeof ROLE]

export const ALL_ROLE_LEVELS: readonly RoleLevel[] = [
  ROLE.VIEWER,
  ROLE.COMMENTER,
  ROLE.REVIEWER,
  ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
  ROLE.OWNER,
]

/**
 * Roles offered when minting a share link. Capped at contributor — we never
 * grant managerial roles (project_lead and up) via a tokenized URL. The
 * server enforces this same cap on POST /api/v2/projects/:id/invites; the
 * client subset here is a UX hint, not the security boundary.
 */
export const LINK_ROLE_ALLOWED: readonly RoleLevel[] = [
  ROLE.VIEWER,
  ROLE.COMMENTER,
  ROLE.REVIEWER,
  ROLE.CONTRIBUTOR,
]

/**
 * Roles offered in the per-project Members panel role picker. Owner (700)
 * is intentionally excluded — ownership is conferred on project creation
 * and isn't transferable via the picker.
 */
export const PROJECT_ROLE_PICKER: readonly RoleLevel[] = [
  ROLE.VIEWER,
  ROLE.COMMENTER,
  ROLE.REVIEWER,
  ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
]

/**
 * Roles offered in the org Members panel role picker. Commenter (200) and
 * reviewer (300) are absent because org-level grants apply to every project
 * in the org — granting "comment-only across all projects" is a niche we
 * don't surface yet. Set explicitly per-project via SharePanel instead.
 */
export const ORG_ROLE_PICKER: readonly RoleLevel[] = [
  ROLE.VIEWER,
  ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
]

/**
 * Roles offered as the project's "minimum validator role" floor
 * (ValidationSettingsSection). An intentional subset of the canonical ladder:
 * reviewer (300) is the lowest role that can validate cells (see
 * `roleDescription`), and the floor caps at maintainer — owner is the org
 * boundary, not a per-project validation floor. Drawn from the canonical ladder
 * so the labels read identically to every other role surface (member / invite /
 * share) — no per-surface taxonomy drift (AQU-352). The names these map to
 * (`reviewer` / `project_lead` / `maintainer`) are exactly the ProjectRecord
 * `validationRoleFloor` union; keep the two in sync.
 */
export const VALIDATION_FLOOR_ROLES: readonly RoleLevel[] = [
  ROLE.REVIEWER,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
]

/** Canonical role name for a given level (mirrors server's ROLE_NAMES). */
export function roleName(level: number): string {
  switch (level) {
    case 100: return "viewer"
    case 200: return "commenter"
    case 300: return "reviewer"
    case 400: return "contributor"
    case 500: return "project_lead"
    case 600: return "maintainer"
    case 700: return "owner"
    default: return `level_${level}`
  }
}

/** One-line description shown in role pickers. */
export function roleDescription(level: number): string {
  switch (level) {
    case 100: return "Read-only access to cells + comments"
    case 200: return "Read + add comments on cells"
    case 300: return "Read + comment + validate cells (no content edits)"
    case 400: return "Read + comment + edit cell content"
    case 500: return "Contributor + manage members"
    case 600: return "Lead + manage roles"
    case 700: return "Full control"
    default: return ""
  }
}

/**
 * Human-readable role option for picker UIs. Combines the canonical name
 * with its long description; `name` and `description` keep the existing
 * shape used by SharePanel/MembersPage/MembersPanel.
 */
export interface RoleOption {
  level: RoleLevel
  name: string
  description: string
}

function toOption(level: RoleLevel): RoleOption {
  return { level, name: roleName(level), description: roleDescription(level) }
}

export const PROJECT_ROLE_OPTIONS: readonly RoleOption[] =
  PROJECT_ROLE_PICKER.map(toOption)

export const ORG_ROLE_OPTIONS: readonly RoleOption[] =
  ORG_ROLE_PICKER.map(toOption)

export const LINK_ROLE_OPTIONS: readonly RoleOption[] =
  LINK_ROLE_ALLOWED.map(toOption)

export const VALIDATION_FLOOR_ROLE_OPTIONS: readonly RoleOption[] =
  VALIDATION_FLOOR_ROLES.map(toOption)
