import { useEffect, useRef, useState } from "react"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { useFrontierSession } from "./useFrontierSession"

export interface UserSearchResult {
  id: number
  username: string
}

export interface UseUserSearch {
  /** The current debounced query that the server is matching against. */
  query: string
  /** Match results. Empty when: query is below min-prefix, query was
   * canceled, or genuinely no matches. Use `lastFetchOk` to disambiguate
   * the empty-because-no-match case from empty-because-the-fetch-failed. */
  results: UserSearchResult[]
  /** True while a request is in flight for the current query. */
  isLoading: boolean
  /** True when query.length < MIN_PREFIX (no fetch fires yet). Lets the UI
   * render a "type more" hint distinct from "no matches." */
  needsMorePrefix: boolean
  /** Whether the most recent fetch (for the current debouncedQuery)
   * completed with a 2xx response. False when the fetch errored, the
   * endpoint 404'd (likely deployed-build is older than the search
   * route), or no fetch has been made yet. The UI should NOT render a
   * "no Frontier user named X" message when this is false — that would
   * be a confidently-wrong claim about whether the user exists. */
  lastFetchOk: boolean
}

const MIN_PREFIX = 2
const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_LIMIT = 10

/**
 * Debounced username prefix-search for the Add-member typeahead.
 *
 * - Fires GET /api/v2/users/search?prefix=X&limit=N after `debounceMs`
 *   of input idle. Below the 2-char minimum the hook short-circuits
 *   and reports `needsMorePrefix = true` without a request.
 * - Cancels in-flight requests when the query changes; out-of-order
 *   responses for stale queries are dropped.
 * - Treats network or HTTP errors as "no results" silently — the
 *   typeahead degrades to a plain input without erroring loudly.
 *
 * Why a fresh hook instead of reusing existing patterns: the
 * debounced-cancel-on-change semantics are different from the
 * fire-once-on-mount pattern we use for org/members; conflating them
 * would make this hook awkward to reason about.
 */
export function useUserSearch(
  query: string,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
  limit: number = DEFAULT_LIMIT
): UseUserSearch {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [isLoading, setLoading] = useState(false)
  const [lastFetchOk, setLastFetchOk] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  const aliveRef = useRef(true)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // Debounce the query itself; the fetch effect reacts to debouncedQuery.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), debounceMs)
    return () => clearTimeout(t)
  }, [query, debounceMs])

  useEffect(() => {
    const trimmed = debouncedQuery.trim()
    if (!jwt || trimmed.length < MIN_PREFIX) {
      // Below threshold or signed out — no fetch, no results, no
      // truth-claim about whether anyone matches.
      if (aliveRef.current) {
        setResults([])
        setLoading(false)
        setLastFetchOk(false)
      }
      return
    }

    const seq = ++requestSeqRef.current
    const controller = new AbortController()
    setLoading(true)
    setLastFetchOk(false)

    fetch(
      `${AUTH_BASE}/api/v2/users/search?prefix=${encodeURIComponent(trimmed)}&limit=${limit}`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: controller.signal,
      }
    )
      .then(async (res) => {
        // Drop stale responses — a newer query has already fired.
        if (seq !== requestSeqRef.current) return
        if (!aliveRef.current) return
        if (!res.ok) {
          // The endpoint may be missing on this deployment (older build
          // than the client expects), or the worker is down. Either way
          // we don't have a real "no matches" answer — flag it so the UI
          // doesn't claim the user doesn't exist.
          setResults([])
          setLastFetchOk(false)
          return
        }
        const body = (await res.json()) as { users: UserSearchResult[] }
        setResults(body.users ?? [])
        setLastFetchOk(true)
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return
        if (aliveRef.current) {
          setResults([])
          setLastFetchOk(false)
        }
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return
        if (aliveRef.current) setLoading(false)
      })

    return () => controller.abort()
  }, [debouncedQuery, jwt, limit])

  return {
    query: debouncedQuery,
    results,
    isLoading,
    needsMorePrefix: debouncedQuery.trim().length > 0 && debouncedQuery.trim().length < MIN_PREFIX,
    lastFetchOk,
  }
}
