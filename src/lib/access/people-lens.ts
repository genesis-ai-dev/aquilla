/**
 * AQU-2319: the People lens on `/orgs/:id/access`. One roster of members,
 * guests, and pending invites, derived from the same access payload as the
 * Places lens. This module does not decide who can open a place.
 */
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { ORG_WIDE_ACCESS_FLOOR } from "@/lib/frontier/roles"

import { formatScopePath, scopeCrumbs, scopePathKey } from "./scope-path"
import type { AccessChainEntry, ScopePath, ScopeRef } from "./types"

/** Ninety days. A person with no timestamp counts as inactive. */
export const INACTIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000

/** Granted-at shows this many direct-grant breadcrumbs, then "+N". */
export const GRANTED_AT_SHOWN = 2

/**
 * `/orgs/:id/access-audit` sends the reader here. Everyone is the default
 * filter, so the query does not name one.
 */
export const ACCESS_AUDIT_REDIRECT = "../access?lens=people"

export const PEOPLE_FILTERS = ["everyone", "members", "guests", "invites", "granters", "inactive"] as const
export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]

export interface RosterPerson {
  userId: string
  displayName: string
  email?: string | null
  isGuest: boolean
  lastActiveAt?: string | null
  pendingInvite?: { expiresAt: string | null; roleLevel: number }
  grants: AccessChainEntry[]
}

export interface PlaceCounts {
  teams: number
  projects: number
}

export type Reach =
  | { kind: "everything"; teams: number; projects: number }
  | { kind: "projects"; count: number }
  | { kind: "lanes"; count: number }
  | { kind: "membership" }

interface PlaceNode {
  scope: { type: string; id: string }
  children?: readonly PlaceNode[]
}

export function parsePeopleFilter(raw: string | null): PeopleFilter {
  return PEOPLE_FILTERS.find((filter) => filter === raw) ?? "everyone"
}

export function parseAccessLens(raw: string | null): "places" | "people" {
  return raw === "people" ? "people" : "places"
}

/** Teams and projects in the places tree the viewer was sent. */
export function countPlaces(nodes: readonly PlaceNode[]): PlaceCounts {
  const teams = new Set<string>()
  const projects = new Set<string>()
  const walk = (list: readonly PlaceNode[]) => {
    for (const node of list) {
      if (node.scope.type === "team") teams.add(node.scope.id)
      if (node.scope.type === "project") projects.add(node.scope.id)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return { teams: teams.size, projects: projects.size }
}

function innermost(path: ScopePath): ScopeRef | undefined {
  const visible = scopeCrumbs(path).filter((scope) => !scope.hidden && scope.name)
  return visible[visible.length - 1]
}

/** A grant that opens something. An organization role below Maintainer does not. */
function grantOpens(grant: AccessChainEntry): boolean {
  const place = innermost(grant.scopePath)
  if (!place || grant.roleLevel == null) return false
  if (place.type === "org") return grant.roleLevel >= ORG_WIDE_ACCESS_FLOOR
  return true
}

/**
 * The solid pill. A pending invite wears the invited role. A bare organization
 * member, whose membership opens no project, has no role yet.
 */
export function highestRoleLevel(person: RosterPerson): number | null {
  if (person.pendingInvite) return person.pendingInvite.roleLevel
  let max: number | null = null
  for (const grant of person.grants) {
    if (!grantOpens(grant) || grant.roleLevel == null) continue
    if (max == null || grant.roleLevel > max) max = grant.roleLevel
  }
  return max
}

/** Maintainer or Owner at any place. An invite has not been granted yet. */
export function canGiveAccess(person: RosterPerson): boolean {
  if (person.pendingInvite) return false
  return person.grants.some((grant) => (grant.roleLevel ?? 0) >= ORG_WIDE_ACCESS_FLOOR)
}

export function personReach(person: RosterPerson, counts: PlaceCounts): Reach {
  const orgWide = person.grants.some((grant) => {
    const place = innermost(grant.scopePath)
    return place?.type === "org" && (grant.roleLevel ?? 0) >= ORG_WIDE_ACCESS_FLOOR
  })
  if (orgWide) return { kind: "everything", teams: counts.teams, projects: counts.projects }

  const projects = new Set<string>()
  const lanes = new Set<string>()
  for (const grant of person.grants) {
    if (!grantOpens(grant)) continue
    const place = innermost(grant.scopePath)
    if (!place) continue
    if (place.type === "lane") {
      lanes.add(place.id)
      continue
    }
    const project = grant.scopePath.find((scope) => scope.type === "project" && !scope.hidden)
    if (project) projects.add(project.id)
    else if (place.type === "project") projects.add(place.id)
  }
  if (projects.size > 0) return { kind: "projects", count: projects.size }
  if (lanes.size > 0) return { kind: "lanes", count: lanes.size }
  return { kind: "membership" }
}

export function formatReach(t: TFunction, reach: Reach): string {
  switch (reach.kind) {
    case "everything":
      return t("org.access.people.everything", {
        teams: t("org.access.people.teamCount", { count: reach.teams }),
        projects: t("org.access.people.projectCount", { count: reach.projects }),
      })
    case "projects":
      return t("org.access.people.projectCount", { count: reach.count })
    case "lanes":
      return t("org.access.people.laneCount", { count: reach.count })
    case "membership":
      return t("org.access.people.membershipOpensNothing")
  }
}

/** Direct and creator grants, stable, capped at two breadcrumbs. */
export function grantedAtPlaces(person: RosterPerson): { shown: ScopePath[]; extra: number } {
  const direct = person.grants.filter((grant) => grant.origin.kind === "direct" || grant.origin.kind === "creator")
  direct.sort((a, b) => {
    const byLabel = formatScopePath(a.scopePath).localeCompare(formatScopePath(b.scopePath))
    if (byLabel !== 0) return byLabel
    return scopePathKey(a.scopePath).localeCompare(scopePathKey(b.scopePath))
  })
  return {
    shown: direct.slice(0, GRANTED_AT_SHOWN).map((grant) => grant.scopePath),
    extra: Math.max(0, direct.length - GRANTED_AT_SHOWN),
  }
}

export function isInactive(lastActiveAt: string | null | undefined, now: number): boolean {
  if (!lastActiveAt) return true
  const at = Date.parse(lastActiveAt)
  if (Number.isNaN(at)) return true
  return now - at >= INACTIVE_AFTER_MS
}

export function matchesPeopleFilter(person: RosterPerson, filter: PeopleFilter, now: number): boolean {
  const invite = person.pendingInvite != null
  switch (filter) {
    case "everyone":
      return true
    case "members":
      return !person.isGuest && !invite
    case "guests":
      return person.isGuest && !invite
    case "invites":
      return invite
    case "granters":
      return canGiveAccess(person)
    case "inactive":
      return !invite && isInactive(person.lastActiveAt, now)
  }
}

export function personMatchesSearch(person: RosterPerson, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (person.displayName.toLowerCase().includes(q)) return true
  if (person.email?.toLowerCase().includes(q)) return true
  return person.grants.some((grant) => {
    if (formatScopePath(grant.scopePath).toLowerCase().includes(q)) return true
    return grant.scopePath.some((scope) => !scope.hidden && scope.name.toLowerCase().includes(q))
  })
}

export function selectRoster<T extends RosterPerson>(
  people: readonly T[],
  opts: { query: string; filter: PeopleFilter; now: number },
): T[] {
  return people.filter((person) => personMatchesSearch(person, opts.query) && matchesPeopleFilter(person, opts.filter, opts.now))
}

export function rosterCounts(
  people: readonly RosterPerson[],
  query: string,
  now: number,
): Record<PeopleFilter, number> {
  const searched = people.filter((person) => personMatchesSearch(person, query))
  return {
    everyone: searched.length,
    members: searched.filter((person) => matchesPeopleFilter(person, "members", now)).length,
    guests: searched.filter((person) => matchesPeopleFilter(person, "guests", now)).length,
    invites: searched.filter((person) => matchesPeopleFilter(person, "invites", now)).length,
    granters: searched.filter((person) => matchesPeopleFilter(person, "granters", now)).length,
    inactive: searched.filter((person) => matchesPeopleFilter(person, "inactive", now)).length,
  }
}
