/**
 * AQU-2320: the Give access dialog's choices, decided without React.
 *
 * Every rule here reads src/lib/access/grant-rules.ts and the `grantable`
 * map the server computed with that same rule, so the dialog offers exactly
 * what the dry run (and the write route behind it) will accept.
 */
import {
  INVITE_ROLE_CAP,
  SCOPE_ROLES,
  offeredRoles,
  type GrantDenial,
  type PlaceGrantability,
} from "./grant-rules"
import { placeParam } from "./place-lens"
import type { ScopeRef, ScopeType } from "./types"

interface PlaceNode {
  scope: ScopeRef
  children: readonly PlaceNode[]
}

/** One row of the place picker: the Places lens tree, depth-first. */
export interface PlaceRow {
  key: string
  scope: ScopeRef
  /** Outermost first, this place last. */
  path: ScopeRef[]
  depth: number
  /** The project a lane belongs to (or the project itself). */
  projectId?: string
  grantable: PlaceGrantability
}

/** Why a place cannot be picked. An invite also rules out teams. */
export type PlaceBlock = GrantDenial | "no_team_invite"

export type PersonChoice =
  | {
      kind: "account"
      userId: string
      displayName: string
      /** What the write routes look the account up by; the dry run names `userId`. Null: cannot be written. */
      username: string | null
      email: string | null
      isGuest: boolean
    }
  | { kind: "invite"; email: string }

const NOT_LOADED: PlaceGrantability = { ok: false, denial: "owner_only" }

/**
 * The tree flattened for the picker. A project attached to two teams sits
 * under the first; a list item must be one place, once.
 */
export function placeRows(tree: readonly PlaceNode[], grantable: Readonly<Record<string, PlaceGrantability>> | undefined): PlaceRow[] {
  const rows: PlaceRow[] = []
  const seen = new Set<string>()
  const walk = (nodes: readonly PlaceNode[], path: ScopeRef[], depth: number, projectId?: string) => {
    for (const node of nodes) {
      const key = placeParam(node.scope)
      const here = [...path, node.scope]
      const pid = node.scope.type === "project" ? node.scope.id : projectId
      if (!seen.has(key)) {
        seen.add(key)
        // A payload from before AQU-2320 carries no map: nothing is grantable, the server stays the boundary.
        rows.push({ key, scope: node.scope, path: here, depth, projectId: pid, grantable: grantable?.[key] ?? NOT_LOADED })
      }
      walk(node.children, here, depth + 1, pid)
    }
  }
  walk(tree, [], 0)
  return rows
}

export function placeBlock(row: PlaceRow, person: PersonChoice | null): PlaceBlock | null {
  if (!row.grantable.ok) return row.grantable.denial
  if (person?.kind === "invite" && INVITE_ROLE_CAP[row.scope.type] === null) return "no_team_invite"
  return null
}

/**
 * Roles the role blank offers. With a place: that place's rungs under the
 * granter's cap there. Before a place is picked: every role some open place
 * would take, so choosing the role first never hides a place.
 */
export function roleOptions(rows: readonly PlaceRow[], place: PlaceRow | null, person: PersonChoice | null): number[] {
  const invite = person?.kind === "invite"
  const forRow = (row: PlaceRow) =>
    placeBlock(row, person) == null && row.grantable.ok ? offeredRoles(row.scope.type, row.grantable.cap, { invite }) : []
  const levels = place ? forRow(place) : rows.flatMap(forRow)
  return [...new Set(levels)].sort((a, b) => b - a)
}

/** Why a chosen role no longer fits a newly chosen place. */
export type RoleReset =
  | { reason: "not_offered"; roleLevel: number; place: ScopeType }
  | { reason: "above_cap"; roleLevel: number; cap: number }
  | { reason: "above_invite_cap"; roleLevel: number; cap: number }

export function roleReset(roleLevel: number, place: PlaceRow, person: PersonChoice | null): RoleReset | null {
  if (roleOptions([], place, person).includes(roleLevel)) return null
  const type = place.scope.type
  if (!SCOPE_ROLES[type].includes(roleLevel)) return { reason: "not_offered", roleLevel, place: type }
  const inviteCap = INVITE_ROLE_CAP[type]
  if (person?.kind === "invite" && inviteCap != null && roleLevel > inviteCap) {
    return { reason: "above_invite_cap", roleLevel, cap: inviteCap }
  }
  return { reason: "above_cap", roleLevel, cap: place.grantable.ok ? place.grantable.cap : 0 }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An address the person blank may turn into an invite. */
export function inviteEmail(query: string): string | null {
  const trimmed = query.trim().toLowerCase()
  return EMAIL.test(trimmed) ? trimmed : null
}

/** Request body for POST /orgs/:id/access/preview. */
export function previewRequest(person: PersonChoice, roleLevel: number, place: PlaceRow) {
  return {
    place: { type: place.scope.type, id: place.scope.id },
    roleLevel,
    person: person.kind === "account" ? { userId: person.userId } : { email: person.email },
  }
}
