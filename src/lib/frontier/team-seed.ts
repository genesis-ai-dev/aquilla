// What the team endpoints last answered in this tab, so a team's page can
// paint what the teams list (or a previous visit) already showed. Same
// contract as portfolio-seed.ts: never read instead of the server, replaced by
// the page's own read, scoped to one JWT, empty after a reload.

import type { TeamDetail, TeamSummary } from "./teams"

let scopeJwt: string | null = null
const names = new Map<string, string>()
const details = new Map<string, TeamDetail>()

function scope(jwt: string): void {
  if (scopeJwt === jwt) return
  scopeJwt = jwt
  names.clear()
  details.clear()
}

const key = (orgId: number, groupId: number) => `${orgId}:${groupId}`

export function rememberTeamSummaries(jwt: string, orgId: number, teams: readonly TeamSummary[]): void {
  scope(jwt)
  for (const team of teams) names.set(key(orgId, team.id), team.name)
}

export function rememberTeamDetail(jwt: string, orgId: number, team: TeamDetail): void {
  scope(jwt)
  details.set(key(orgId, team.id), team)
  names.set(key(orgId, team.id), team.name)
}

export function readTeamDetailSeed(jwt: string | null, orgId: number | null, groupId: number | null): TeamDetail | null {
  if (!jwt || orgId == null || groupId == null || scopeJwt !== jwt) return null
  return details.get(key(orgId, groupId)) ?? null
}

export function readTeamNameSeed(jwt: string | null, orgId: number | null, groupId: number | null): string | null {
  if (!jwt || orgId == null || groupId == null || scopeJwt !== jwt) return null
  return names.get(key(orgId, groupId)) ?? null
}

/** Test-only. */
export function clearTeamSeeds(): void {
  scopeJwt = null
  names.clear()
  details.clear()
}
