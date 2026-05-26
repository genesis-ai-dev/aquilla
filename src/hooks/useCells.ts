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
import { streamFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"

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

  statsRef.current = auditStats
  usernameRef.current = username
  requiredRef.current = requiredValidations
  tokenFetcherRef.current = getToken
  projectRef.current = projectId
  fileRef.current = fileId
  enabledRef.current = enabled

  const rebuildFromCache = useCallback(() => {
    const rows = rowsRef.current
    if (rows.length === 0) {
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
    setCells(out)
  }, [])

  // `soft`: a same-file refetch (revalidate after a commit, focus/visibility
  // drift check). It must NOT blank the view — otherwise leaving a cell or
  // returning to the tab flashes the whole list to a skeleton and back. Soft
  // mode streams into a buffer and swaps it in atomically once complete,
  // leaving the current rows (already optimistically patched) visible
  // throughout. A hard fetch (file switch / first load) blanks + shows the
  // skeleton so we never paint the previous file's rows.
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
      return
    }
    // A soft refetch never interrupts an in-flight fetch — it would abort the
    // load and strand the loading state (see inFlightRef). Drop it; the
    // in-flight fetch already pulls the latest state, and the next revalidate
    // after it settles will pick up anything newer.
    if (soft && inFlightRef.current) return
    const gen = ++generationRef.current
    inFlightRef.current = true
    if (!soft) {
      // CellAreaState drops to `syncing-empty` (skeleton) until the first
      // page lands.
      rowsRef.current = []
      setCells([])
      setIsLoading(true)
    }
    setIsError(false)
    try {
      const token = getToken ? await getToken(fileId) : null
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      // Stream pages in: on a hard fetch, append each page to the cache and
      // rebuild so the first 500 rows paint immediately on Bible-sized files
      // (~30k cells × ~60 round-trips). On a soft refetch, accumulate into a
      // buffer and swap it in once at the end so the visible list never
      // flickers (and never shrink-then-grows across pages). The `gen` fence
      // aborts the stream if the caller switches files mid-flight.
      const buffer: CellRow[] = []
      await streamFileCells(projectId, fileId, token, (rows) => {
        if (generationRef.current !== gen) return false
        if (rows.length === 0) return
        if (soft) {
          for (const r of rows) buffer.push(r)
          return
        }
        rowsRef.current = rowsRef.current.length === 0
          ? rows.slice()
          : rowsRef.current.concat(rows)
        rebuildFromCache()
      })
      if (generationRef.current !== gen) return
      if (soft) {
        rowsRef.current = buffer
        rebuildFromCache()
      }
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

  return { cells, revalidate, applyOptimisticTargetEdit, isLoading, isError }
}
