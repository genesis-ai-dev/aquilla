/**
 * AQU-2321: what a Places-lens row may do — change its role, or be removed —
 * decided without React from the `grantable` map and the shared rule in
 * grant-rules.ts (the one the auth-worker's removal dry run applies).
 */
import { removalCheck, roleChangeOptions, type EditCheck, type EditDenial, type PlaceGrantability } from "./grant-rules"
import type { ScopeRef } from "./types"

/** A grant the Places lens can write: org, team or project rows. Lane rows belong to lane staffing (AQU-2322). */
export interface GrantRef {
  type: "org" | "team" | "project"
  id: string
}

/** One row of "Granted here", as the lens draws it. */
export interface DirectRow {
  userId: string
  roleLevel: number
  source?: "direct" | "creator" | "invite"
}

/** `cap` is the viewer's own role there, when the reason names it. */
export type RowEdit =
  | { ok: true; roles: number[] }
  | { ok: false; reason: EditDenial | "creator" | "invite"; cap: number | null }

export type RowRemoval = { ok: true } | { ok: false; reason: EditDenial | "creator"; cap: number | null }

const NOT_LOADED: PlaceGrantability = { ok: false, denial: "owner_only" }

/** The grant behind a direct row on this place. A lane row has none this slice can write. */
export function rowGrant(scope: ScopeRef): GrantRef | null {
  return scope.type === "lane" ? null : { type: scope.type, id: scope.id }
}

/** The People-lens id of an invite drawn on a node as `invite:<token>`. */
export function inviteRowId(scope: ScopeRef, path: readonly ScopeRef[], rowId: string): string | null {
  if (!rowId.startsWith("invite:")) return null
  const token = rowId.slice("invite:".length)
  if (scope.type === "org") return `invite:org:${token}`
  const project = path.find((s) => s.type === "project")
  return project ? `invite:project:${project.id}:${token}` : null
}

const grantability = (grantable: Readonly<Record<string, PlaceGrantability>> | undefined, place: { type: string; id: string }) =>
  grantable?.[`${place.type}:${place.id}`] ?? NOT_LOADED

/** The roles the row's dropdown offers, or why it is not a dropdown. */
export function rowEdit(scope: ScopeRef, row: DirectRow, grantable: Readonly<Record<string, PlaceGrantability>> | undefined, isSelf: boolean): RowEdit {
  if (row.source === "creator") return { ok: false, reason: "creator", cap: null }
  if (row.source === "invite") return { ok: false, reason: "invite", cap: null }
  const result = roleChangeOptions(scope.type, grantability(grantable, scope), { roleLevel: row.roleLevel, isSelf })
  return result.ok ? result : { ok: false, reason: result.denial, cap: result.cap }
}

/** Whether the row's × may open the Remove dialog, or why not. */
export function rowRemoval(scope: ScopeRef, path: readonly ScopeRef[], row: DirectRow, grantable: Readonly<Record<string, PlaceGrantability>> | undefined, isSelf: boolean): RowRemoval {
  if (row.source === "creator") return { ok: false, reason: "creator", cap: null }
  const invite = row.source === "invite"
  // An invite on a lane is a project invite; it is cancelled at the project.
  const place = invite && scope.type === "lane" ? path.find((s) => s.type === "project") ?? scope : scope
  const check: EditCheck = removalCheck(place.type, grantability(grantable, place), { roleLevel: row.roleLevel, isSelf, invite })
  return check.ok ? { ok: true } : { ok: false, reason: check.denial, cap: check.cap }
}

export const grantKey = (g: GrantRef) => `${g.type}:${g.id}`

/** "X, Y and 3 more": the first `max` names and how many are left. */
export function shortList(names: readonly string[], max = 2): { shown: string[]; more: number } {
  if (names.length <= max + 1) return { shown: [...names], more: 0 }
  return { shown: names.slice(0, max), more: names.length - max }
}
