import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"

export interface PortfolioProject {
  id: string
  name: string
  totalCells: number
  validatedCells: number
  lastEditAt: number | null
}

export async function getPortfolio(jwt: string, orgId: number): Promise<PortfolioProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new Error(`getPortfolio failed: HTTP ${res.status}`)
  return ((await res.json()) as { projects: PortfolioProject[] }).projects
}

/** validated fraction 0..1 (0 when no cells). */
export function validatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.validatedCells / p.totalCells : 0
}

/** Attention score: higher = more attention needed. Stalled (>14d / never edited) ranks above low completion. */
export function attentionRank(p: PortfolioProject, now: number): number {
  const ageMs = p.lastEditAt != null ? now - p.lastEditAt : Infinity
  const stale = ageMs > 14 * 24 * 60 * 60 * 1000 ? 1 : 0
  return stale * 1000 + (1 - validatedPct(p)) * 100
}
