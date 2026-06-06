// Phase 2b: project-wide search hits the sync-worker's FTS5-backed
// `cells_fts` index. Pre-Phase 2b this hook owned a JS-side substring index
// (`WorkspaceIndex`) built by walking every cell off each file's Y.Doc —
// that path is dead now that cells live on the server. The shape callers
// consume is preserved (results, search, clear, ready, loading) so the
// search UI compiles unchanged; new server-only fields (rank, snippet) are
// exposed alongside.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchProjectSearch, fetchParallelPassages } from "@/lib/sync/search-read"
import type { ParallelPassageResult, SearchResult } from "@/lib/sync/search-read-types"
import type { MatchField } from "@/lib/search/workspace-index"
import type { FileReference } from "@/lib/parsers/types"

export type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"

export interface UseWorkspaceSearchOptions {
  projectId: string | null
  /** Optional fetcher for a sync-token JWT scoped to the project. Phase 2b
   *  accepts a generic "give me a token for this file" fetcher (any file in
   *  the project works for project-scoped reads, but we keep the signature
   *  consistent with the rest of the migrated hooks). */
  getToken?: (fileId: string) => Promise<string | null>
  /** Files in the project. Used solely to (a) provide a stable fallback
   *  fileId for token minting and (b) resolve fileName -> human label on
   *  matched results. */
  files?: FileReference[]
  enabled?: boolean
}

interface SearchOptionsApi {
  /** Restrict to one file. Server-side filter is not implemented yet —
   *  Phase 2c. For now we filter client-side after the fetch. */
  fileId?: string
  /** Server clamps to 500; default 50. */
  limit?: number
  /** "source" | "target" | "both". When omitted or "both", both sides are returned. */
  side?: "both" | "source" | "target"
}

function makeResult(row: SearchResult, files: FileReference[] | undefined): WorkspaceSearchResult {
  const f = files?.find((x) => x.id === row.fileId)
  // Plant the matched value into the right slot for back-compat callers.
  return {
    cellId: row.cellId,
    fileId: row.fileId,
    fileName: f?.name ?? "",
    original: row.side === "source" ? row.value : "",
    translated: row.side === "target" ? row.value : "",
    context: "",
    matchedFields: new Set<MatchField>(
      row.side === "source" ? ["original"] : ["translated"],
    ),
    matchCount: 1,
    matchedTokens: [],
    snippet: row.snippet,
    rank: row.rank,
  }
}

function makePassageResult(
  row: ParallelPassageResult,
  files: FileReference[] | undefined,
): WorkspaceSearchResult {
  const base = makeResult(row, files)
  return { ...base, paired: row.pairedValue }
}

/**
 * Server-backed search. The hook tracks `loading` while a fetch is in
 * flight and `ready` as a sentinel ("at least one search resolved") for
 * UX gates that used to wait on the JS index to finish building.
 *
 * Backwards-compatible signature: callers that don't pass options get a
 * no-op `buildIndex` (the server has no index to build) and an empty
 * result array until they call `search(query)`.
 */
export function useWorkspaceSearch(
  filesOrOpts?: FileReference[] | UseWorkspaceSearchOptions,
  optsLegacy: { projectId?: string | null; getToken?: (fileId: string) => Promise<string | null> } = {},
): {
  buildIndex: () => Promise<void>
  rebuild: () => Promise<void>
  search: (query: string, options?: SearchOptionsApi) => Promise<void>
  searchParallelPassages: (
    query: string,
    opts?: { projectIds?: string[]; side?: "source" | "target"; limit?: number },
  ) => Promise<void>
  clear: () => void
  results: WorkspaceSearchResult[]
  loading: boolean
  ready: boolean
} {
  // Polymorphic shape: pre-2b callers passed `(files)` positionally; the
  // 2b shape passes one options object. Accept either.
  const options: UseWorkspaceSearchOptions = Array.isArray(filesOrOpts)
    ? { files: filesOrOpts, projectId: optsLegacy.projectId ?? null, getToken: optsLegacy.getToken }
    : filesOrOpts ?? { projectId: null }
  const { projectId, getToken, files, enabled = true } = options

  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)

  const projectRef = useRef(projectId)
  const filesRef = useRef(files)
  const tokenFetcherRef = useRef(getToken)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  // Mirror props into refs inside an effect so `search()` (called later from
  // user input / external triggers) always reads the latest values without
  // re-binding. eslint's react-hooks plugin doesn't like the inline-assign
  // shortcut Phase 2a's `useCells` uses for this — keep them in an effect.
  useEffect(() => {
    projectRef.current = projectId
    filesRef.current = files
    tokenFetcherRef.current = getToken
    enabledRef.current = enabled
  }, [projectId, files, getToken, enabled])

  // Reset ready when the project changes — switching projects requires a
  // fresh first-search to mark ready again. Use the setState-during-render
  // pattern: store the last-seen projectId in component state and update it
  // alongside the reset; React drops the redundant render if the projectId
  // hasn't changed.
  const [lastProjectId, setLastProjectId] = useState<string | null>(projectId)
  if (lastProjectId !== projectId) {
    setLastProjectId(projectId)
    setReady(false)
    setResults([])
  }

  const search = useCallback(async (query: string, opts: SearchOptionsApi = {}) => {
    const pid = projectRef.current
    const fetchToken = tokenFetcherRef.current
    if (!enabledRef.current || !pid) {
      setResults([])
      return
    }
    const cleaned = query.trim()
    if (!cleaned) {
      setResults([])
      return
    }
    const gen = ++generationRef.current
    setLoading(true)
    try {
      // The project-scope sync-token is minted per file; pick any file in
      // the project as the scope target. When `files` is empty we fall
      // back to a sentinel — identity mints project-scoped tokens off
      // the projectId; the fileId in the token is unused on these reads.
      const scopeFile = opts.fileId ?? filesRef.current?.[0]?.id ?? "any"
      const token = fetchToken ? await fetchToken(scopeFile) : null
      if (!token) {
        if (generationRef.current !== gen) return
        setResults([])
        setLoading(false)
        return
      }
      const sideParam = opts.side === "both" ? undefined : opts.side
      const rows = await fetchProjectSearch(
        pid,
        cleaned,
        { side: sideParam, limit: opts.limit },
        token,
      )
      if (generationRef.current !== gen) return
      const mapped = rows.map((r) => makeResult(r, filesRef.current))
      const filtered = opts.fileId
        ? mapped.filter((r) => r.fileId === opts.fileId)
        : mapped
      setResults(filtered)
      setReady(true)
      setLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useWorkspaceSearch] search failed:", err)
      setResults([])
      setLoading(false)
    }
  }, [])

  const searchParallelPassages = useCallback(
    async (
      query: string,
      opts: { projectIds?: string[]; side?: "source" | "target"; limit?: number } = {},
    ) => {
      const pid = projectRef.current
      const fetchToken = tokenFetcherRef.current
      if (!enabledRef.current || !pid) {
        setResults([])
        return
      }
      const cleaned = query.trim()
      if (!cleaned) {
        setResults([])
        return
      }
      // Default to the current project when no explicit list is given.
      const projectIds =
        opts.projectIds && opts.projectIds.length > 0 ? opts.projectIds : [pid]

      const gen = ++generationRef.current
      setLoading(true)
      try {
        // Build a token getter that uses the first file in the project as the
        // scope target (consistent with `search()`). For multi-project use,
        // callers are expected to pass a fetcher that handles each projectId.
        const tokenGetter = fetchToken
          ? async (targetProjectId: string) => {
              // For the current project, mint via an arbitrary file scope.
              if (targetProjectId === pid) {
                const scopeFile = filesRef.current?.[0]?.id ?? "any"
                return fetchToken(scopeFile)
              }
              // For foreign projects we have no file list — attempt with a
              // sentinel; the server mints project-scoped tokens off projectId.
              return fetchToken("any")
            }
          : async (_id: string) => null as string | null

        const rows = await fetchParallelPassages(
          cleaned,
          { projectIds, side: opts.side, limit: opts.limit },
          tokenGetter,
        )
        if (generationRef.current !== gen) return
        const mapped = rows.map((r) => makePassageResult(r, filesRef.current))
        setResults(mapped)
        setReady(true)
        setLoading(false)
      } catch (err) {
        if (generationRef.current !== gen) return
        console.warn("[useWorkspaceSearch] searchParallelPassages failed:", err)
        setResults([])
        setLoading(false)
      }
    },
    [],
  )

  const clear = useCallback(() => {
    setResults([])
  }, [])

  // buildIndex / rebuild are kept as no-ops for back-compat. There's no
  // client-side index to build now — the FTS5 index lives server-side and
  // is maintained by the projection.
  const buildIndex = useCallback(async () => {
    setReady(true)
  }, [])

  const rebuild = useCallback(async () => {
    setReady(false)
    return buildIndex()
  }, [buildIndex])

  return { buildIndex, rebuild, search, searchParallelPassages, clear, results, loading, ready }
}
