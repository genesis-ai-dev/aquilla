// What the portfolio endpoints last answered in this tab, kept in memory so a
// page reached from a list can paint the rows that list was already showing.
//
// Like project-record-seed.ts, this is NOT a cache in the AD-3 sense: nothing
// is ever read from it instead of the server. Every reader still issues its
// own request and replaces what it painted; a hard reload starts empty.
//
// Scoped to one JWT. A different token (another account, or the same account
// after a refresh) starts over rather than paint somebody else's portfolio.

import type { OrgPortfolioSummary, PortfolioDirectoryPage, PortfolioProject } from "./portfolio"

let scopeJwt: string | null = null
const summaries = new Map<number, OrgPortfolioSummary>()
const summariesProjectIds = new Map<number, Set<string>>()
const rows = new Map<string, PortfolioProject>()
const directoryPages = new Map<string, PortfolioDirectoryPage>()

function scope(jwt: string): void {
  if (scopeJwt === jwt) return
  scopeJwt = jwt
  summaries.clear()
  summariesProjectIds.clear()
  rows.clear()
  directoryPages.clear()
}

export function rememberPortfolioRows(jwt: string, projects: readonly PortfolioProject[]): void {
  scope(jwt)
  for (const project of projects) rows.set(project.id, project)
}

export function rememberOrgPortfolio(jwt: string, orgId: number, summary: OrgPortfolioSummary): void {
  scope(jwt)
  summaries.set(orgId, summary)
  // The whole org answered: a project it no longer lists is gone, archived or
  // out of reach, and its old row must not paint on its overview.
  const listed = new Set(summary.projects.map((p) => p.id))
  const previous = summariesProjectIds.get(orgId)
  if (previous) for (const id of previous) if (!listed.has(id)) rows.delete(id)
  summariesProjectIds.set(orgId, listed)
  for (const project of summary.projects) rows.set(project.id, project)
}
export function readOrgPortfolioSeed(jwt: string | null, orgId: number | null): OrgPortfolioSummary | null {
  if (!jwt || orgId == null || scopeJwt !== jwt) return null
  return summaries.get(orgId) ?? null
}

/** The row any portfolio read last returned for this project. */
export function readPortfolioRowSeed(jwt: string | null, projectId: string): PortfolioProject | null {
  if (!jwt || scopeJwt !== jwt) return null
  return rows.get(projectId) ?? null
}

/** First page of the unfiltered project directory for a set of orgs. */
export function rememberDirectoryPage(jwt: string, orgKey: string, page: PortfolioDirectoryPage): void {
  scope(jwt)
  directoryPages.set(orgKey, page)
  rememberPortfolioRows(jwt, page.projects)
}

export function readDirectoryPageSeed(jwt: string | null, orgKey: string): PortfolioDirectoryPage | null {
  if (!jwt || scopeJwt !== jwt) return null
  return directoryPages.get(orgKey) ?? null
}

/** Test-only. */
export function clearPortfolioSeeds(): void {
  scopeJwt = null
  summaries.clear()
  summariesProjectIds.clear()
  rows.clear()
  directoryPages.clear()
}
