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
 *
 * This module is a pure lib — no React, no `useT()` — so it stays
 * locale-free (AQU-832 wave 3, WS-08): `roleName()` returns the canonical,
 * untranslated machine name used for comparisons/sorting/the wire format;
 * `roleNameKey()`/`roleDescriptionKey()` return `MessageKey`s a component
 * resolves with `t()`, the same "return a descriptor, let the caller
 * localize" shape `src/lib/navigation/deriveTitle.ts` uses.
 */
import type { MessageKey } from "@/lib/i18n/messages/en"

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
 * `roleDescriptionKey`), and the floor caps at maintainer — owner is the org
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

/** Canonical role name for a given level (mirrors server's ROLE_NAMES).
 *
 * This is the machine-readable, locale-free identifier — the wire format
 * shared with the server (migration 0013) and the value every comparison,
 * sort, or lookup in this codebase keys on. It is NEVER translated: routing
 * it through the message catalog would silently break permission logic (a
 * switch on the current locale's word for "viewer") the moment a non-English
 * locale renders. For a user-facing label, resolve `roleNameKey()` through
 * `useT()` instead — see the module doc comment below. */
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

/**
 * Catalog key → display label lookup, keyed by the canonical role name.
 * `common.role.*` (`src/lib/i18n/namespaces/common.ts`) authors each as a
 * `plural({ one, other })` pair: `one` is the singular label ("Viewer"),
 * `other` is the plural noun ("Viewers"). Never build the plural by
 * concatenating "s" onto the singular — see AQU-623 / the fixed bug in
 * `src/lib/permissions/denial.ts`.
 */
const ROLE_NAME_KEY: Partial<Record<string, MessageKey>> = {
  viewer: "common.role.viewer",
  commenter: "common.role.commenter",
  reviewer: "common.role.reviewer",
  contributor: "common.role.contributor",
  project_lead: "common.role.projectLead",
  maintainer: "common.role.maintainer",
  owner: "common.role.owner",
}

const ROLE_DESCRIPTION_KEY: Partial<Record<number, MessageKey>> = {
  100: "common.role.viewerDescription",
  200: "common.role.commenterDescription",
  300: "common.role.reviewerDescription",
  400: "common.role.contributorDescription",
  500: "common.role.projectLeadDescription",
  600: "common.role.maintainerDescription",
  700: "common.role.ownerDescription",
}

/**
 * Catalog key for a role's display name, from either a numeric level or its
 * canonical name string. Returns `undefined` for a non-canonical level (the
 * `level_${level}` sentinel from `roleName()`) — there is no vocabulary for
 * that in the catalog, because it should never reach a user; callers fall
 * back to `unknownRoleLabel()`.
 *
 * `src/lib/` is a pure lib — it cannot call the `useT()` hook — so this
 * returns a `MessageKey` and the caller resolves it: `t(roleNameKey(level)!,
 * { count: 1 })` for the singular label, `{ count: 2 }` (or any count other
 * than 1) for the plural noun. `RoleLabel`/`useRoleDisplayName` in
 * `src/components/RoleLabel.tsx` do this once so most call sites don't have
 * to.
 */
export function roleNameKey(nameOrLevel: string | number): MessageKey | undefined {
  const name = typeof nameOrLevel === "number" ? roleName(nameOrLevel) : nameOrLevel
  return ROLE_NAME_KEY[name]
}

/** Catalog key for a role's one-line description (role pickers). `undefined`
 *  for a non-canonical level — see `roleNameKey()`. */
export function roleDescriptionKey(level: number): MessageKey | undefined {
  return ROLE_DESCRIPTION_KEY[level]
}

/** English fallback for a level outside the canonical ladder (corrupt data,
 *  a future server-side level this client doesn't know yet). Never real UI
 *  vocabulary — nothing to translate, it's a "this shouldn't happen" label —
 *  so it stays English, mirroring the `raw()` escape hatch in
 *  `src/lib/navigation/deriveTitle.ts`. */
export function unknownRoleLabel(level: number): string {
  return `Level ${level}`
}

/** Minimal `t()` shape shared by every pure lib module that needs to resolve
 *  a `MessageKey` without importing `useT()`/React — mirrors `TFunction` from
 *  `I18nProvider` structurally. */
export type RoleT = (key: MessageKey, vars?: Record<string, string | number>) => string

type TFn = RoleT

/**
 * Resolve a role's display label given a `t()` function — for call sites
 * that build plain-string label lists (e.g. `<Select>` items) outside JSX,
 * where the `<RoleLabel>` component can't be used. Falls back to
 * `unknownRoleLabel()` for a non-canonical level/name.
 */
export function resolveRoleName(
  t: TFn,
  nameOrLevel: string | number,
  opts?: { plural?: boolean },
): string {
  const key = roleNameKey(nameOrLevel)
  if (!key) {
    return typeof nameOrLevel === "number" ? unknownRoleLabel(nameOrLevel) : nameOrLevel
  }
  return t(key, { count: opts?.plural ? 2 : 1 })
}

/** Resolve a role's one-line description given a `t()` function. Empty
 *  string for a non-canonical level (mirrors the old `roleDescription()`
 *  default). */
export function resolveRoleDescription(t: TFn, level: number): string {
  const key = roleDescriptionKey(level)
  return key ? t(key) : ""
}

/**
 * Role option for picker UIs. `name` is the canonical machine-readable name
 * (never rendered directly — resolve `nameKey`/`descriptionKey` through
 * `t()`, or pass `level` to `<RoleLabel>`).
 */
export interface RoleOption {
  level: RoleLevel
  name: string
  nameKey: MessageKey
  descriptionKey: MessageKey
}

function toOption(level: RoleLevel): RoleOption {
  const nameKey = roleNameKey(level)
  const descriptionKey = roleDescriptionKey(level)
  if (!nameKey || !descriptionKey) {
    throw new Error(`roles.ts: no catalog keys for canonical level ${level}`)
  }
  return { level, name: roleName(level), nameKey, descriptionKey }
}

export const PROJECT_ROLE_OPTIONS: readonly RoleOption[] =
  PROJECT_ROLE_PICKER.map(toOption)

export const ORG_ROLE_OPTIONS: readonly RoleOption[] =
  ORG_ROLE_PICKER.map(toOption)

export const LINK_ROLE_OPTIONS: readonly RoleOption[] =
  LINK_ROLE_ALLOWED.map(toOption)

export const VALIDATION_FLOOR_ROLE_OPTIONS: readonly RoleOption[] =
  VALIDATION_FLOOR_ROLES.map(toOption)
