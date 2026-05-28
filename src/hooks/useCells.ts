// Phase 2c-β: useCells reads from the sync-worker `cells` projection (D1)
// via HTTP and surfaces AD-2 chain pointers (`event_id`, `source_event_id`)
// on each cell so the editor's commit path can pin `parentId` + `sourceEventId`
// at emit time. Writes flow through the outbox via `events-emit.ts`;
// `revalidate()` is called after a known write or on a remote
// `event.applied` WS broadcast.
//
// The public return type (`CellData`) is preserved so existing consumers
// keep compiling. Fields whose event grammars are deferred to v1.x — threads,
// validation edit history, attachments, audio timings, waivers — come back
// as defaults; the residual Y.Doc-coupled feature surfaces that read them
// are scheduled for rip in Phase 2c-γ.

import { useCallback, useEffect, useRef, useState } from "react"
import type { CellHistoryEntry, SourceLocation, CommentThread, CellTtsSettings } from "@/lib/parsers/types"
import type { CodexCellAttachment, EditTypeValue, ValidationEntry, WordTiming } from "@/lib/codex-editor/types"
import type { CellAuditStats } from "./useCellsAuditStats"
import { streamFileCells, fetchCellsByIds } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { readCellsCache, writeCellsCache } from "@/lib/sync/cells-cache"
import { peekOutboxBatch, subscribeToOutbox } from "@/lib/sync/outbox"

/**
 * Per-edit summary used by the validation popover timeline. Was previously
 * exported from `@/lib/codex-editor/edits/types`; inlined here when the
 * `cell.edits` Y.Doc grammar went away. The shape is preserved so the
 * timeline UI keeps compiling; the read path that populates it is deferred
 * to v1.x — `validationHistory` is empty in this build.
 */
export interface EditValidationSummary {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  validatorsActive: string[]
  validatorsAll: ValidationEntry[]
}

export type ValidationStatus = "empty" | "none" | "others" | "self" | "full"

export interface CellData {
  id: string
  fileId: string
  /** True iff a `target.cell.commit` / `target.cell.create` for this cell is
   *  still sitting in the IndexedDB outbox (offline, retrying, or just enqueued).
   *  When set, `translated` / `translatedHtml` reflect the *pending* value, not
   *  the server projection. UI can render a subtle "queued" indicator. */
  hasPendingEdit?: boolean
  cellLabel?: string
  original: string
  originalHtml?: string
  translated: string
  /** Rich-text variant of the target value, populated from `cells.value_html`.
   *  Hydrates the plain TipTap editor on mount. */
  translatedHtml?: string
  /** AD-2 chain head for the target row (most recent winning event_id). Used
   *  as `parentId` on the next `target.cell.commit` emit. Undefined when no
   *  target row has been projected yet (genesis target write). */
  targetEventId?: string
  /** AD-9 staleness pin observed at the last target commit. */
  targetSourceEventId?: string | null
  /** Source row's `event_id` — pinned into `target.cell.commit.payload.sourceEventId`. */
  sourceEventId?: string
  context: string
  group: string
  /** Optional section label for navigation/progress. */
  section?: string
  globalReferences?: string[]
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: ValidationStatus
  endorsementCount?: number
  activeValidators: string[]
  /** Empty in Phase 2a — useCellEditHistory will own this in Phase 2b. */
  validationHistory: EditValidationSummary[]
  /** Empty in Phase 2a — useCellHistory will own this in Phase 2b. */
  history: CellHistoryEntry[]
  /** Empty in Phase 2a — useComments will own this in Phase 2b. */
  threads: CommentThread[]
  sourceLocation?: SourceLocation
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
  attachments?: Record<string, CodexCellAttachment>
  selectedAudioId?: string
  selectedGeneratedVoiceAudioId?: string
  audioTimings?: Record<string, WordTiming[]>
  ttsSettings?: CellTtsSettings
  startTime?: number
  endTime?: number
  waivers?: import("@/lib/parsers/types").RuleWaiver[]
}

const EMPTY_STATS: ReadonlyMap<string, CellAuditStats> = new Map()
const EMPTY_VALIDATION_HISTORY: EditValidationSummary[] = []
const EMPTY_HISTORY: CellHistoryEntry[] = []
const EMPTY_THREADS: CommentThread[] = []
const EMPTY_WAIVERS: import("@/lib/parsers/types").RuleWaiver[] = []

function classifyValidators(
  active: string[],
  currentUsername: string,
  requiredValidations: number,
): ValidationStatus {
  if (active.length === 0) return "none"
  if (active.length >= requiredValidations) return "full"
  if (active.includes(currentUsername)) return "self"
  return "others"
}

function deriveStatus(
  translated: string,
  validated: boolean,
): "empty" | "unvalidated" | "validated" {
  if (!translated || !translated.trim()) return "empty"
  return validated ? "validated" : "unvalidated"
}

/**
 * Build one CellData from a (source row, target row) pair. Either may be
 * undefined — source-only cells produce a CellData with empty `translated`;
 * target-only cells produce one with empty `original`.
 */
function buildCellData(
  cellId: string,
  source: CellRow | undefined,
  target: CellRow | undefined,
  fileId: string,
  username: string,
  requiredValidations: number,
  stats: CellAuditStats | undefined,
): CellData {
  const translated = target?.value ?? ""
  const original = source?.value ?? ""

  const activeValidators = stats?.activeValidators ?? []
  const validationStatus: ValidationStatus =
    !translated.trim()
      ? "empty"
      : activeValidators.length > 0
        ? classifyValidators(activeValidators, username, requiredValidations)
        : target?.validated
          ? "full"
          : "none"

  // Prefer the target row's `validated` flag as the source of truth for the
  // simple "is it green?" UI. When no stats are present, this is the only
  // available signal — D1 already encodes the "validators-meet-threshold"
  // gate at the projection layer.
  const validatedForStatus =
    target?.validated ?? activeValidators.length >= requiredValidations

  return {
    id: cellId,
    fileId,
    original,
    originalHtml: source?.valueHtml ?? undefined,
    translated,
    translatedHtml: target?.valueHtml ?? undefined,
    sourceEventId: source?.eventId,
    targetEventId: target?.eventId,
    targetSourceEventId: target?.sourceEventId ?? null,
    context: "",
    group: target?.canonicalRef ?? source?.canonicalRef ?? "",
    type: target?.type ?? source?.type ?? "text",
    status: deriveStatus(translated, validatedForStatus),
    validationStatus,
    endorsementCount: target?.endorsementCount ?? source?.endorsementCount ?? 0,
    activeValidators,
    validationHistory: EMPTY_VALIDATION_HISTORY,
    history: EMPTY_HISTORY,
    threads: EMPTY_THREADS,
    globalReferences: source?.canonicalRef ? [source.canonicalRef] : undefined,
    waivers: stats?.waivers ?? EMPTY_WAIVERS,
  }
}

/**
 * Pair source + target rows by `cellId` (AD-9). The server returns source
 * rows in anchor-chain order, then target rows in anchor-chain order;
 * iterating once over each side preserves the source chain for paired
 * cells, then appends any target-only cells at the tail.
 */
function joinSourceAndTarget(rows: CellRow[]): {
  ordered: string[]
  sources: Map<string, CellRow>
  targets: Map<string, CellRow>
} {
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  const sourceOrder: string[] = []
  const targetOrder: string[] = []
  for (const r of rows) {
    if (r.side === "source") {
      if (!sources.has(r.cellId)) {
        sources.set(r.cellId, r)
        sourceOrder.push(r.cellId)
      }
    } else if (r.side === "target") {
      if (!targets.has(r.cellId)) {
        targets.set(r.cellId, r)
        targetOrder.push(r.cellId)
      }
    }
  }
  const seen = new Set(sourceOrder)
  const ordered = [...sourceOrder]
  for (const id of targetOrder) {
    if (!seen.has(id)) ordered.push(id)
  }
  return { ordered, sources, targets }
}

export interface UseCellsOptions {
  projectId: string | null
  fileId: string | null
  username?: string
  requiredValidations?: number
  /** Optional D1 audit stats overlay. When present, `activeValidators` /
   *  `validationStatus` come from here. */
  auditStats?: ReadonlyMap<string, CellAuditStats>
  /** Mints a sync-token JWT for the (projectId, fileId) the hook reads.
   *  Without a fetcher the hook returns `isError: true` and an empty array. */
  getToken?: (fileId: string) => Promise<string | null>
  /** Disable the fetch (e.g. before identity loads). */
  enabled?: boolean
}

export interface UseCellsResult {
  cells: CellData[]
  /** Manual refetch — call after a known write so the UI reflects it. */
  revalidate: () => void
  /** Targeted refetch for a single cell. Used by the WS-triggered
   *  `event.applied` handler so a remote validate/commit only pulls the
   *  one changed cell instead of re-streaming every cell in the file.
   *  Coalesces concurrent calls for the same id; falls back to a full
   *  revalidate if the targeted fetch fails. */
  revalidateCell: (cellId: string) => void
  /** Optimistically patch a target-side cell's value in the local cache.
   *  Used by the editor commit path so rule infractions + per-cell UI
   *  re-derive instantly (no round-trip wait). The follow-up server fetch
   *  (`revalidate()`) overwrites this with the authoritative projection. */
  applyOptimisticTargetEdit: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  isLoading: boolean
  isError: boolean
}

/**
 * Phase 2a primary entry point. Fetches cells from the sync-worker's
 * `cells` projection on mount, on focus, and on `revalidate()`.
 *
 * No subscription; D1 is the load path (AD-3 v1 thin client). Refetch on
 * focus is the cheap drift mitigation while we're still on Y.Doc for writes
 * — once Phase 2c lands an outbox-driven invalidation, this becomes
 * smarter.
 */
export function useCells(opts: UseCellsOptions): UseCellsResult {
  const {
    projectId,
    fileId,
    username = "local",
    requiredValidations = 1,
    auditStats = EMPTY_STATS,
    getToken,
    enabled = true,
  } = opts

  const [cells, setCells] = useState<CellData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  // Refs let revalidate() / focus handlers run without retriggering the
  // load effect; that effect only re-runs when (projectId, fileId, enabled)
  // change. Stats/username/threshold updates rebuild from cached rows.
  const rowsRef = useRef<CellRow[]>([])
  // Pending outbox overlay: per-cell pending value/valueHtml from
  // target.cell.commit / target.cell.create events still in IndexedDB. Applied
  // on top of the server projection in rebuildFromCache so refreshes (and
  // initial loads) reflect locally-queued edits before sync lands. Cleared
  // entries roll off automatically as the flusher removes them from IDB.
  const pendingOverlayRef = useRef<Map<string, { value: string; valueHtml?: string }>>(new Map())
  const statsRef = useRef<ReadonlyMap<string, CellAuditStats>>(auditStats)
  const usernameRef = useRef(username)
  const requiredRef = useRef(requiredValidations)
  const tokenFetcherRef = useRef(getToken)
  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const enabledRef = useRef(enabled)
  // Race fence: bumped on every fetch start; ignore responses whose
  // generation < current. Prevents an in-flight slow fetch from clobbering
  // state after the caller switched files.
  const generationRef = useRef(0)
  // True while a fetch is streaming. A soft refetch (revalidate) must NOT
  // interrupt an in-flight fetch: doing so aborts it via the gen fence,
  // strands `isLoading` at true (the `setIsLoading(false)` is gated behind a
  // gen check that now fails), and — under the burst of `event.applied`
  // broadcasts that arrive on connect — starves the stream so cells never
  // arrive. Hard fetches (file switch / first load) still take over.
  const inFlightRef = useRef(false)
  // Backoff state for token-null retries. Auth races (JWT arrives a tick
  // after `enabled` flips true) and transient /sync-token failures resolve
  // on their own; we keep the skeleton up and retry rather than dropping to
  // the empty-state UI as if the file genuinely has no cells.
  const tokenRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenAttemptsRef = useRef(0)

  statsRef.current = auditStats
  usernameRef.current = username
  requiredRef.current = requiredValidations
  tokenFetcherRef.current = getToken
  projectRef.current = projectId
  fileRef.current = fileId
  enabledRef.current = enabled

  const rebuildFromCache = useCallback(() => {
    // AD-3 v1 thin client: the view is exactly the D1 projection. Pending
    // local writes live in the outbox and surface only after the reconciler
    // delivers them and `revalidate()` refetches — never as a client-side
    // read overlay (that's the v2 progressive-caching tier).
    const rows = rowsRef.current
    const overlay = pendingOverlayRef.current
    if (rows.length === 0 && overlay.size === 0) {
      setCells([])
      return
    }
    const { ordered, sources, targets } = joinSourceAndTarget(rows)
    const fid = fileRef.current ?? ""
    const out: CellData[] = ordered.map((cellId) =>
      buildCellData(
        cellId,
        sources.get(cellId),
        targets.get(cellId),
        fid,
        usernameRef.current,
        requiredRef.current,
        statsRef.current.get(cellId),
      ),
    )
    if (overlay.size > 0) {
      for (const cell of out) {
        const o = overlay.get(cell.id)
        if (!o) continue
        cell.translated = o.value
        if (o.valueHtml !== undefined) cell.translatedHtml = o.valueHtml
        // Pending edits are by definition unvalidated until they replay
        // through the server projection.
        cell.status = deriveStatus(o.value, false)
        cell.hasPendingEdit = true
      }
    }
    setCells(out)
  }, [])

  // `soft`: a same-file refetch (revalidate after a commit, focus/visibility
  // drift check). It must NOT blank the view — otherwise leaving a cell or
  // returning to the tab flashes the whole list to a skeleton and back. Soft
  // mode streams into a buffer and swaps it in atomically once complete,
  // leaving the current rows (already optimistically patched) visible
  // throughout. A hard fetch (file switch / first load) blanks + shows the
  // skeleton so we never paint the previous file's rows.
  //
  // Cache: a hard fetch first checks the IDB cache for `${projectId}:${fileId}`.
  // A hit paints the cached rows immediately and promotes the refresh to soft
  // mode so the user sees content in <50ms while the network fetch streams in
  // and atomically replaces the snapshot. A miss falls through to the original
  // skeleton-then-stream behavior.
  const doFetch = useCallback(async (soft = false) => {
    const projectId = projectRef.current
    const fileId = fileRef.current
    const enabled = enabledRef.current
    const getToken = tokenFetcherRef.current
    if (!enabled || !projectId || !fileId) {
      setCells([])
      setIsLoading(false)
      setIsError(false)
      rowsRef.current = []
      if (tokenRetryRef.current) {
        clearTimeout(tokenRetryRef.current)
        tokenRetryRef.current = null
      }
      tokenAttemptsRef.current = 0
      return
    }
    // A soft refetch never interrupts an in-flight fetch — it would abort the
    // load and strand the loading state (see inFlightRef). Drop it; the
    // in-flight fetch already pulls the latest state, and the next revalidate
    // after it settles will pick up anything newer.
    if (soft && inFlightRef.current) return
    const gen = ++generationRef.current
    inFlightRef.current = true
    let usedCache = false
    if (!soft) {
      // Try the IDB cache before showing a skeleton. A hit paints cached rows
      // synchronously into rowsRef, hides the skeleton, and demotes the rest
      // of the fetch to soft mode (atomic swap on completion) so the user
      // never flickers from cached rows → skeleton → fresh rows.
      const cached = await readCellsCache(projectId, fileId)
      if (generationRef.current !== gen) return
      if (cached && cached.rows.length > 0) {
        rowsRef.current = cached.rows
        rebuildFromCache()
        setIsLoading(false)
        usedCache = true
      } else {
        // CellAreaState drops to `syncing-empty` (skeleton) until the first
        // page lands.
        rowsRef.current = []
        setCells([])
        setIsLoading(true)
      }
    }
    // If we hydrated from cache, the rest of this fetch behaves like a soft
    // refetch: accumulate into a buffer and swap once at the end.
    const effectiveSoft = soft || usedCache
    setIsError(false)
    try {
      const token = getToken ? await getToken(fileId) : null
      if (!token) {
        if (generationRef.current !== gen) return
        // Token unavailable: probably an auth race or transient /sync-token
        // failure. Keep the skeleton up and retry with backoff (250ms → 4s)
        // so the file appears as soon as auth resolves. After ~6 attempts
        // surface isError so the UI can show a real failure state.
        const attempt = ++tokenAttemptsRef.current
        inFlightRef.current = false
        if (attempt >= 6) {
          setIsError(true)
          setIsLoading(false)
          return
        }
        const delay = Math.min(4000, 250 * 2 ** (attempt - 1))
        if (tokenRetryRef.current) clearTimeout(tokenRetryRef.current)
        tokenRetryRef.current = setTimeout(() => {
          tokenRetryRef.current = null
          if (generationRef.current === gen) void doFetch(soft)
        }, delay)
        return
      }
      tokenAttemptsRef.current = 0
      // Stream pages in: on a hard fetch, append each page to the cache and
      // rebuild so the first 500 rows paint immediately on Bible-sized files
      // (~30k cells × ~60 round-trips). On a soft refetch, accumulate into a
      // buffer and swap it in once at the end so the visible list never
      // flickers (and never shrink-then-grows across pages). The `gen` fence
      // aborts the stream if the caller switches files mid-flight.
      const buffer: CellRow[] = []
      const pushRows = (rows: CellRow[], rebuild: boolean): boolean | void => {
        if (generationRef.current !== gen) return false
        if (rows.length === 0) return
        if (effectiveSoft) {
          for (const r of rows) buffer.push(r)
          return
        }
        rowsRef.current = rowsRef.current.length === 0
          ? rows.slice()
          : rowsRef.current.concat(rows)
        if (rebuild) rebuildFromCache()
      }
      // Stream the TARGET side first. The combined read returns every source
      // row before any target row, so on a Bible-sized file (~30k source cells
      // vs. a handful of translated target cells) fetching both sides at once
      // hides every translation behind the entire ~60-page source stream —
      // committed edits look lost on reload until the whole file loads. The
      // target side is tiny (one page), so loading it up front means a
      // translated cell shows its value the moment its source row paints.
      // Seed it silently (no rebuild) so we don't flash target-only orphan rows.
      await streamFileCells(projectId, fileId, token, (rows) => pushRows(rows, false), "target")
      if (generationRef.current !== gen) return
      await streamFileCells(projectId, fileId, token, (rows) => pushRows(rows, true), "source")
      if (generationRef.current !== gen) return
      if (effectiveSoft) {
        rowsRef.current = buffer
      }
      // Final rebuild: the source pass paints per page, but a target-only or
      // empty-source file yields no source page to trigger one — and the
      // target seed pass is intentionally silent. This also swaps in the soft
      // buffer. Cheap and idempotent on the hard path.
      rebuildFromCache()
      // Persist the freshly-loaded snapshot. Best-effort; failures are
      // swallowed inside writeCellsCache so a hostile IDB never breaks the
      // load path.
      void writeCellsCache(projectId, fileId, rowsRef.current)
      // Always clear loading on completion — including when a soft refetch
      // finishes after a hard load that got superseded — so the skeleton can
      // never get stuck on.
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCells] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    } finally {
      // Only the current-generation fetch owns the in-flight flag; a
      // superseded fetch must not clear it out from under its successor.
      if (generationRef.current === gen) inFlightRef.current = false
    }
  }, [rebuildFromCache])

  // Reload on (projectId, fileId, enabled) change.
  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, enabled])

  // Re-derive when stats / username / threshold change without refetching.
  useEffect(() => {
    rebuildFromCache()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditStats, username, requiredValidations])

  // Pending-outbox overlay: rebuild the per-cell map whenever the outbox
  // changes (enqueue, attempt, removal-on-success), and also reload it when
  // the active file changes. peekOutboxBatch returns rows in enqueuedAt asc
  // order, so iterating once and writing into a Map yields last-write-wins
  // per cellId — matching the order the server will eventually apply them in.
  useEffect(() => {
    if (!enabled || !fileId) {
      pendingOverlayRef.current = new Map()
      return
    }
    let cancelled = false
    async function refresh() {
      const all = await peekOutboxBatch(2000)
      if (cancelled) return
      const fid = fileRef.current
      const next = new Map<string, { value: string; valueHtml?: string }>()
      for (const r of all) {
        if (fid && r.event.fileId !== fid) continue
        const k = r.event.kind
        if (k !== "target.cell.commit" && k !== "target.cell.create") continue
        const cellId = r.event.cellId
        if (!cellId) continue
        const p = r.event.payload as { value?: string; valueHtml?: string }
        if (typeof p.value !== "string") continue
        next.set(cellId, { value: p.value, valueHtml: p.valueHtml })
      }
      pendingOverlayRef.current = next
      rebuildFromCache()
    }
    void refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [enabled, fileId, rebuildFromCache])

  // Cancel any pending token-retry on unmount.
  useEffect(() => () => {
    if (tokenRetryRef.current) {
      clearTimeout(tokenRetryRef.current)
      tokenRetryRef.current = null
    }
  }, [])

  // Refetch on focus / visibility return. Insurance against drift while
  // writes still flow through Y.Doc — a peer's commit becomes visible
  // without a manual reload.
  useEffect(() => {
    if (typeof window === "undefined") return
    function onFocus() { void doFetch(true) }
    function onVis() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void doFetch(true)
      }
    }
    window.addEventListener("focus", onFocus)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis)
    }
    return () => {
      window.removeEventListener("focus", onFocus)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis)
      }
    }
  }, [doFetch])

  const revalidate = useCallback(() => {
    void doFetch(true)
  }, [doFetch])

  // Targeted single-cell refetch. WS `event.applied` calls this with the
  // changed cellId so a remote validate/commit only pulls one row instead
  // of re-streaming the entire file (which is ~thousands of cells for a
  // Bible book and was the dominant cause of slow remote-change feedback).
  //
  // Coalesces concurrent in-flight fetches per cellId, drops the patch if
  // the file/project changed mid-flight, and falls back to a full
  // revalidate on any error so we never end up with stale local state on a
  // transient network blip.
  //
  // FUTURE: replace this HTTP round-trip with a server-pushed row payload
  // on the existing `event.applied` WS frame (Supabase-realtime style). That
  // saves a round-trip per change and is the right shape for the deferred
  // AD-13/14 neighborhood propagation, which will dirty many cells per
  // event — fanning out N targeted GETs would be worse than today's full
  // refetch. See TODO in sync-worker/src/events/event-projection.ts.
  const cellFetchInFlightRef = useRef<Set<string>>(new Set())
  const revalidateCell = useCallback((cellId: string) => {
    const projectId = projectRef.current
    const fileId = fileRef.current
    const enabled = enabledRef.current
    const getToken = tokenFetcherRef.current
    if (!enabled || !projectId || !fileId || !getToken) return
    if (cellFetchInFlightRef.current.has(cellId)) return
    cellFetchInFlightRef.current.add(cellId)
    const gen = generationRef.current
    void (async () => {
      try {
        const token = await getToken(fileId)
        if (!token) return
        if (generationRef.current !== gen) return
        const rows = await fetchCellsByIds(projectId, fileId, [cellId], token)
        if (generationRef.current !== gen) return
        if (projectRef.current !== projectId || fileRef.current !== fileId) return
        const cache = rowsRef.current
        // Replace any existing rows for this cellId; rows arrive as one
        // source + one target (either may be absent).
        const next = cache.filter((r) => r.cellId !== cellId)
        next.push(...rows)
        rowsRef.current = next
        rebuildFromCache()
      } catch {
        // Targeted fetch failed — fall back to the full file refetch so
        // we never strand stale local state on a transient network blip.
        if (generationRef.current === gen) void doFetch(true)
      } finally {
        cellFetchInFlightRef.current.delete(cellId)
      }
    })()
  }, [doFetch, rebuildFromCache])

  // Optimistic local patch for the target row of a single cell. We mutate
  // the cached `rowsRef` entry in place (creating one if no target row yet
  // exists — first-time commits on source-only pairs) and rebuild the
  // paired view. `useHealth` keys its per-cell cache on
  // `${status} ${original} ${translated}`, so the changed cell's signature
  // shifts and rules re-run for that one cell on the next render; every
  // other cell's cache entry remains valid.
  //
  // The next `revalidate()` (called by the parent after outbox flush) will
  // overwrite this with the authoritative server projection.
  const applyOptimisticTargetEdit = useCallback(
    (cellId: string, patch: { value: string; valueHtml?: string }) => {
      const rows = rowsRef.current
      let touched = false
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.cellId !== cellId || r.side !== "target") continue
        rows[i] = { ...r, value: patch.value, valueHtml: patch.valueHtml ?? null }
        touched = true
        break
      }
      if (!touched) {
        // No target row yet — first commit against a source-only pair. Mint
        // a synthetic target row by cloning the source row's anchor/cellId
        // and replacing the value-bearing fields. event_id stays null until
        // the server projection lands; useHealth doesn't care about event_id.
        const src = rows.find((r) => r.cellId === cellId && r.side === "source")
        if (!src) return // unknown cellId — nothing to optimise
        rows.push({
          ...src,
          side: "target",
          value: patch.value,
          valueHtml: patch.valueHtml ?? null,
          // Sentinel until the server projection lands and revalidate() runs.
          eventId: "",
          sourceEventId: src.eventId,
          lastEditor: usernameRef.current,
          lastEditAt: Date.now(),
          validated: false,
          wordCount: patch.value.trim() ? patch.value.trim().split(/\s+/).length : 0,
        })
      }
      rebuildFromCache()
    },
    [rebuildFromCache],
  )

  return { cells, revalidate, revalidateCell, applyOptimisticTargetEdit, isLoading, isError }
}
