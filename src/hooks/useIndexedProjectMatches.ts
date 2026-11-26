import { useEffect, useMemo, useState } from "react"
import { getPortfoliosPage, PORTFOLIO_PAGE_SIZE, type PortfolioProject } from "@/lib/frontier/portfolio"
import { useDebouncedValue } from "./useDebouncedValue"
import type { useProjectNameIndex } from "./useProjectNameIndex"

const pendingDetails = {
  nameOnly: true, totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0,
  audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null, lastEditAt: null,
}

export function useIndexedProjectMatches(
  index: ReturnType<typeof useProjectNameIndex>, query: string, jwt: string | null,
  orgIds: number[], page: PortfolioProject[],
) {
  const term = query.trim().toLowerCase()
  const [pageWindow, setPageWindow] = useState({ term: "", count: PORTFOLIO_PAGE_SIZE })
  const limit = pageWindow.term === term ? pageWindow.count : PORTFOLIO_PAGE_SIZE
  const matches = useMemo(() => index && term ? index.projects.filter(p => p.name.toLowerCase().includes(term)) : null, [index, term])
  const visible = useMemo(() => matches?.slice(0, limit), [matches, limit])
  const [cache, setCache] = useState<{ index: typeof index; rows: Map<string, PortfolioProject | null> } | null>(null)
  const details = useMemo(() => {
    const rows = new Map(cache?.index === index ? cache?.rows : [])
    for (const p of page) rows.set(p.id, p)
    return rows
  }, [cache, index, page])
  const missing = useMemo(() => visible?.filter(p => !details.has(p.id)).slice(0, PORTFOLIO_PAGE_SIZE).map(p => p.id) ?? [], [visible, details])
  const settled = useDebouncedValue(missing, 200)
  const [failure, setFailure] = useState<typeof index>(null)
  useEffect(() => {
    if (!jwt || !index || missing !== settled || !missing.length || failure === index) return
    const controller = new AbortController()
    // Name matching is complete locally. Only hydrate missing progress for visible matches.
    void getPortfoliosPage(jwt, orgIds, { projectIds: missing, limit: missing.length, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        setCache(previous => {
          const rows = new Map(previous?.index === index ? previous.rows : [])
          for (const id of missing) rows.set(id, null)
          for (const p of result.projects) rows.set(p.id, p)
          return { index, rows }
        })
      })
      .catch(() => { if (!controller.signal.aborted) setFailure(index) })
    return () => controller.abort()
  }, [jwt, orgIds, index, missing, settled, failure])
  if (!visible || !matches || failure === index) return null
  return {
    projects: visible.flatMap(name => {
      const data = details.get(name.id)
      return data === null ? [] : [{ ...(data ?? pendingDetails), ...name }]
    }),
    hasMore: matches.length > limit,
    loadMore: () => setPageWindow({ term, count: limit + PORTFOLIO_PAGE_SIZE }),
  }
}
