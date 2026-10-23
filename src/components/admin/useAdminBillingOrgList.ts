import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  getAdminBillingOrg,
  getAdminBillingOrgs,
  type AdminBillingOrg,
  type AdminBillingSort,
  type AdminBillingTierFilter,
} from "@/lib/frontier/admin"

/** Orgs per page. The list is read a page at a time, searched on the server. */
export const PAGE_SIZE = 50
const TIER_FILTERS: readonly AdminBillingTierFilter[] = ["paid", "enterprise", "team", "free"]
const SAVED_FLASH_MS = 3_000

export type RowSaveStatus = { state: "saving" } | { state: "saved" } | { state: "error"; message: string }

/**
 * The admin billing org list: one server page at a time. Search, plan filter,
 * sort and page live in the URL (`q`, `plan`, `sort`, `page`) so a reload or a
 * shared link reopens the same view. A change re-reads only its own row and
 * reports saving / saved / failed on that row, next to the input that changed.
 */
export function useAdminBillingOrgList(jwt: string) {
  const [params, setParams] = useSearchParams()
  const query = params.get("q") ?? ""
  const planParam = params.get("plan")
  const tierFilter: AdminBillingTierFilter | "" = TIER_FILTERS.includes(planParam as AdminBillingTierFilter)
    ? (planParam as AdminBillingTierFilter)
    : ""
  const sort: AdminBillingSort = params.get("sort") === "usage" ? "usage" : "name"
  const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1)
  const offset = (page - 1) * PAGE_SIZE

  const [orgs, setOrgs] = useState<AdminBillingOrg[] | null>(null)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState(query)
  const [listError, setListError] = useState<string | null>(null)
  const [rowStatus, setRowStatus] = useState<Record<number, RowSaveStatus>>({})
  // Bumped to re-read the current page, e.g. after a catalog save.
  const [listVersion, setListVersion] = useState(0)
  // The page request the shown rows answer; differs from pageKey while one is in flight.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** Patch the list's URL keys; any change but paging returns to page one. */
  const updateParams = useCallback(
    (patch: Partial<Record<"q" | "plan" | "sort" | "page", string | null>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (!("page" in patch)) next.delete("page")
          for (const [key, value] of Object.entries(patch)) {
            if (value == null || value === "") next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  // Search on the server once typing pauses.
  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed === query) return
    const timer = setTimeout(() => updateParams({ q: trimmed || null }), 250)
    return () => clearTimeout(timer)
  }, [search, query, updateParams])

  const pageKey = `${query}|${tierFilter}|${sort}|${offset}|${listVersion}`
  useEffect(() => {
    let current = true
    getAdminBillingOrgs(jwt, { q: query, tier: tierFilter || undefined, sort, limit: PAGE_SIZE, offset })
      .then((result) => {
        if (!current || !aliveRef.current) return
        setOrgs(result.orgs)
        setTotal(result.total)
        setListError(null)
        setLoadedKey(pageKey)
      })
      .catch((err: unknown) => {
        if (!current || !aliveRef.current) return
        setListError(err instanceof Error ? err.message : String(err))
        setLoadedKey(pageKey)
      })
    return () => {
      current = false
    }
  }, [jwt, query, tierFilter, sort, offset, pageKey])

  /** Run one org's change, then re-read only that org's row. */
  const act = useCallback(
    async (orgId: number, fn: () => Promise<unknown>) => {
      setRowStatus((prev) => ({ ...prev, [orgId]: { state: "saving" } }))
      try {
        await fn()
        const row = await getAdminBillingOrg(jwt, orgId)
        if (!aliveRef.current) return
        setOrgs((prev) => prev?.map((o) => (o.orgId === orgId ? row : o)) ?? prev)
        setRowStatus((prev) => ({ ...prev, [orgId]: { state: "saved" } }))
        setTimeout(() => {
          if (!aliveRef.current) return
          // Clear only the flash this save set; a newer save or error stays.
          setRowStatus((prev) => {
            if (prev[orgId]?.state !== "saved") return prev
            const next = { ...prev }
            delete next[orgId]
            return next
          })
        }, SAVED_FLASH_MS)
      } catch (err) {
        if (!aliveRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setRowStatus((prev) => ({ ...prev, [orgId]: { state: "error", message } }))
      }
    },
    [jwt],
  )

  return {
    orgs,
    total,
    offset,
    loading: loadedKey !== pageKey,
    listError,
    search,
    setSearch,
    tierFilter,
    setTierFilter: (tier: AdminBillingTierFilter | "") => updateParams({ plan: tier || null }),
    sort,
    setSort: (next: AdminBillingSort) => updateParams({ sort: next === "name" ? null : next }),
    setOffset: (nextOffset: number) =>
      updateParams({ page: nextOffset <= 0 ? null : String(Math.floor(nextOffset / PAGE_SIZE) + 1) }),
    reload: () => setListVersion((v) => v + 1),
    act,
    rowStatus,
  }
}
