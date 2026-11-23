// Phase 2b: project-wide search hits the sync-worker's FTS5-backed
// `cells_fts` index. Pre-Phase 2b this hook owned a JS-side substring index
// (`WorkspaceIndex`) built by walking every cell off each file's Y.Doc —
// that path is dead now that cells live on the server. The shape callers
// consume is preserved (results, search, clear, ready, loading) so the
// search UI compiles unchanged; new server-only fields (rank, snippet) are
// exposed alongside.

import { fileDisplayName } from "@/lib/file-display-name"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { fetchProjectSearch, fetchParallelPassages } from "@/lib/sync/search-read"
import type { ParallelPassageResult, SearchResult } from "@/lib/sync/search-read-types"
import type { MatchField } from "@/lib/search/workspace-index"
import { isHiddenTimelineFile, type FileReference } from "@/lib/parsers/types"

export type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"

export interface UseWorkspaceSearchOptions {
  projectId: string | null
  /** Optional fetcher for a sync-token JWT scoped to the project. Phase 2b
   *  accepts a generic "give me a token for this file" fetcher (any file in
   *  the project works for project-scoped reads, but we keep the signature
   *  consistent with the rest of the migrated hooks). */
  getToken?: (fileId: string) => Promise<string | null>
  /** Files in the project. Used to (a) provide a stable fallback fileId for
   *  token minting, (b) resolve fileName -> human label on matched results and
   *  (c) recognise the audio-cue siblings so their hits can be dropped — which
   *  is why this wants the UNFILTERED list, siblings included (see the call
   *  site in ProjectWorkspace). */
  files?: FileReference[]
  enabled?: boolean
}

interface SearchOptionsApi {
  /** Restrict to one file. The server does the narrowing, so `limit` is
   *  taken within the file rather than across the project. */
  fileId?: string
  /**
   * Rows to return: the server clamps to 500 and defaults to 50. The store's
   * `total` says how many matched beyond them.
   */
  limit?: number
  /** "source" | "target" | "both". When omitted or "both", both sides are returned. */
  side?: "both" | "source" | "target"
  caseSensitive?: boolean
  matchWord?: boolean
  useRegexp?: boolean
}

function makeResult(row: SearchResult, files: FileReference[] | undefined): WorkspaceSearchResult {
  const f = files?.find((x) => x.id === row.fileId)
  // Plant the matched value into the right slot for back-compat callers.
  return {
    cellId: row.cellId,
    fileId: row.fileId,
    fileName: f ? fileDisplayName(f) : "",
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
    // Opposite side of this hit: source text on a target match, target text
    // on a source match. Find & Replace reads this without a second fetch.
    paired: row.pairedValue ?? null,
    canonicalRef: row.canonicalRef ?? null,
    cellType: row.cellType ?? null,
    placeLabel: row.placeLabel ?? null,
    position: row.position ?? null,
  }
}

/**
 * AQU-646 stage 2: the audio-cue siblings' cells are ordinary rows in
 * `cells.value`, so the server's FTS index holds every one of an episode's
 * ~550 transcript lines and will happily match them. They are cue data for one
 * timeline row, not part of the project's text: a hit in one names a file the
 * user cannot open, cannot translate and has never been told exists. Dropped
 * here — at the only place that turns server rows into results — rather than
 * in each of the search UIs.
 */
function audioCueFileIds(files: FileReference[] | undefined): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const f of files ?? []) {
    if (isHiddenTimelineFile(f)) ids.add(f.id)
  }
  return ids
}

function makePassageResult(
  row: ParallelPassageResult,
  files: FileReference[] | undefined,
): WorkspaceSearchResult {
  const base = makeResult(row, files)
  return { ...base, paired: row.pairedValue }
}

/** What a search surface draws: the hits, whether a fetch is in flight, and the "ready" sentinel. */
export interface WorkspaceSearchSnapshot {
  results: WorkspaceSearchResult[]
  /**
   * How many the search matched before the server cut `results` at the limit
   * asked for (AQU-2732). Equal to `results.length` when nothing was cut.
   */
  total: number
  /** `total` is a floor: there are at least that many, and may be more. */
  totalIsLowerBound: boolean
  loading: boolean
  ready: boolean
}

/**
 * Where the search state lives (AQU-2654). It is a store rather than React
 * state of the component that owns the search, because that component is the
 * project workspace: as `useState` there, every keystroke in the search box
 * re-rendered the whole workspace twice (once for `loading`, once for the
 * results). The surfaces that draw results subscribe with
 * {@link useWorkspaceSearchState}; the owner only holds the handle.
 */
export interface WorkspaceSearchStore {
  getSnapshot: () => WorkspaceSearchSnapshot
  subscribe: (listener: () => void) => () => void
}

interface WritableSearchStore extends WorkspaceSearchStore {
  /** One transition, announced once — and not at all when nothing changed. */
  set: (patch: Partial<WorkspaceSearchSnapshot>) => void
}

const NO_RESULTS: WorkspaceSearchResult[] = []
/** An emptied list: the hits and the count of them go together. */
const EMPTY = { results: NO_RESULTS, total: 0, totalIsLowerBound: false } as const

/**
 * The total for the list a surface is handed. Rows this client dropped from
 * the page were counted by the server, so they come off the total; and it is
 * never less than the list.
 */
function totalAfterDrops(serverTotal: number, received: number, kept: number): number {
  return Math.max(kept, serverTotal - (received - kept))
}

function createSearchStore(): WritableSearchStore {
  let snapshot: WorkspaceSearchSnapshot = { ...EMPTY, loading: false, ready: false }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(patch) {
      const next = { ...snapshot, ...patch }
      if (
        next.results === snapshot.results
        && next.total === snapshot.total
        && next.totalIsLowerBound === snapshot.totalIsLowerBound
        && next.loading === snapshot.loading
        && next.ready === snapshot.ready
      ) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Subscribe a search surface to the store it was handed. */
export function useWorkspaceSearchState(store: WorkspaceSearchStore): WorkspaceSearchSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export interface WorkspaceSearchController {
  buildIndex: () => Promise<void>
  rebuild: () => Promise<void>
  search: (query: string, options?: SearchOptionsApi) => Promise<void>
  searchParallelPassages: (
    query: string,
    opts?: { projectIds?: string[]; side?: "source" | "target"; limit?: number },
  ) => Promise<void>
  clear: () => void
  store: WorkspaceSearchStore
}

/**
 * Server-backed search. The store tracks `loading` while a fetch is in
 * flight and `ready` as a sentinel ("at least one search resolved") for
 * UX gates that used to wait on the JS index to finish building.
 *
 * Backwards-compatible signature: callers that don't pass options get a
 * no-op `buildIndex` (the server has no index to build) and an empty
 * result array until they call `search(query)`.
 *
 * This hook never re-renders its caller for a search: it returns the actions
 * and the store. {@link useWorkspaceSearch} is the same thing with the state
 * read in place, for a caller that is itself the search surface.
 */
export function useWorkspaceSearchController(
  filesOrOpts?: FileReference[] | UseWorkspaceSearchOptions,
  optsLegacy: { projectId?: string | null; getToken?: (fileId: string) => Promise<string | null> } = {},
): WorkspaceSearchController {
  // Polymorphic shape: pre-2b callers passed `(files)` positionally; the
  // 2b shape passes one options object. Accept either.
  const options: UseWorkspaceSearchOptions = Array.isArray(filesOrOpts)
    ? { files: filesOrOpts, projectId: optsLegacy.projectId ?? null, getToken: optsLegacy.getToken }
    : filesOrOpts ?? { projectId: null }
  const { projectId, getToken, files, enabled = true } = options

  const [store] = useState(createSearchStore)

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
  // fresh first-search to mark ready again. A layout effect, so the previous
  // project's hits are gone before the new project's first paint; on mount it
  // finds the store already empty and announces nothing.
  useLayoutEffect(() => {
    store.set({ ready: false, ...EMPTY })
  }, [projectId, store])

  const search = useCallback(async (query: string, opts: SearchOptionsApi = {}) => {
    const pid = projectRef.current
    const fetchToken = tokenFetcherRef.current
    if (!enabledRef.current || !pid) {
      store.set(EMPTY)
      return
    }
    const cleaned = query.trim()
    if (!cleaned) {
      store.set(EMPTY)
      return
    }
    const gen = ++generationRef.current
    store.set({ loading: true })
    try {
      // The project-scope sync-token is minted per file; pick any file in
      // the project as the scope target. When `files` is empty we fall
      // back to a sentinel — identity mints project-scoped tokens off
      // the projectId; the fileId in the token is unused on these reads.
      const scopeFile = opts.fileId ?? filesRef.current?.[0]?.id ?? "any"
      const token = fetchToken ? await fetchToken(scopeFile) : null
      if (!token) {
        if (generationRef.current !== gen) return
        store.set({ ...EMPTY, loading: false })
        return
      }
      const sideParam = opts.side === "both" ? undefined : opts.side
      const page = await fetchProjectSearch(
        pid,
        cleaned,
        {
          side: sideParam,
          fileId: opts.fileId,
          limit: opts.limit,
          matchCase: opts.caseSensitive,
          wholeWord: opts.matchWord,
          useRegexp: opts.useRegexp,
        },
        token,
      )
      if (generationRef.current !== gen) return
      const hidden = audioCueFileIds(filesRef.current)
      const mapped = page.results
        .filter((r) => !hidden.has(r.fileId))
        .map((r) => makeResult(r, filesRef.current))
      // The server narrows to the file. This stays for a sync-worker that
      // predates `fileId` and ignores it: the SPA and the worker deploy apart.
      const filtered = opts.fileId
        ? mapped.filter((r) => r.fileId === opts.fileId)
        : mapped
      store.set({
        results: filtered,
        total: totalAfterDrops(page.total, page.results.length, filtered.length),
        totalIsLowerBound: page.totalIsLowerBound,
        ready: true,
        loading: false,
      })
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useWorkspaceSearch] search failed:", err)
      store.set({ ...EMPTY, loading: false })
    }
  }, [store])

  const searchParallelPassages = useCallback(
    async (
      query: string,
      opts: { projectIds?: string[]; side?: "source" | "target"; limit?: number } = {},
    ) => {
      const pid = projectRef.current
      const fetchToken = tokenFetcherRef.current
      if (!enabledRef.current || !pid) {
        store.set(EMPTY)
        return
      }
      const cleaned = query.trim()
      if (!cleaned) {
        store.set(EMPTY)
        return
      }
      // Default to the current project when no explicit list is given.
      const projectIds =
        opts.projectIds && opts.projectIds.length > 0 ? opts.projectIds : [pid]

      const gen = ++generationRef.current
      store.set({ loading: true })
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

        const page = await fetchParallelPassages(
          cleaned,
          { projectIds, side: opts.side, limit: opts.limit },
          tokenGetter,
        )
        if (generationRef.current !== gen) return
        // Cross-project, so `files` only knows the current one — but that is
        // the only project whose siblings this client has fetched, and the
        // only one whose transcripts could be recognised anyway.
        const hidden = audioCueFileIds(filesRef.current)
        const mapped = page.results
          .filter((r) => !hidden.has(r.fileId))
          .map((r) => makePassageResult(r, filesRef.current))
        store.set({
          results: mapped,
          total: totalAfterDrops(page.total, page.results.length, mapped.length),
          totalIsLowerBound: page.totalIsLowerBound,
          ready: true,
          loading: false,
        })
      } catch (err) {
        if (generationRef.current !== gen) return
        console.warn("[useWorkspaceSearch] searchParallelPassages failed:", err)
        store.set({ ...EMPTY, loading: false })
      }
    },
    [store],
  )

  const clear = useCallback(() => {
    store.set(EMPTY)
  }, [store])

  // buildIndex / rebuild are kept as no-ops for back-compat. There's no
  // client-side index to build now — the FTS5 index lives server-side and
  // is maintained by the projection.
  const buildIndex = useCallback(async () => {
    store.set({ ready: true })
  }, [store])

  const rebuild = useCallback(async () => {
    store.set({ ready: false })
    return buildIndex()
  }, [buildIndex, store])

  return { buildIndex, rebuild, search, searchParallelPassages, clear, store }
}

/**
 * {@link useWorkspaceSearchController} with the state read in place — the
 * caller re-renders when the results change. Use the controller when the
 * caller is not what draws them.
 */
export function useWorkspaceSearch(
  filesOrOpts?: FileReference[] | UseWorkspaceSearchOptions,
  optsLegacy: { projectId?: string | null; getToken?: (fileId: string) => Promise<string | null> } = {},
): Omit<WorkspaceSearchController, "store"> & WorkspaceSearchSnapshot {
  const { store, ...actions } = useWorkspaceSearchController(filesOrOpts, optsLegacy)
  const state = useWorkspaceSearchState(store)
  return { ...actions, ...state }
}
