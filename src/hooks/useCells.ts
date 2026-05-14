// Phase 2a: useCells reads from the sync-worker `cells` projection (D1) via
// HTTP. Earlier this hook subscribed to a Y.Doc and reflected its mutations
// directly into React state; under AD-2 the event log is the source of truth
// and the projection is the load path (AD-3 v1 thin client). Writes still
// flow through Y.Doc in Phase 2a — `revalidate()` lets callers refetch after
// a known write. Phase 2c removes the Y.Doc and switches writes to the
// outbox.
//
// The public return type (`CellData`) is preserved so existing consumers
// (EditorTable, CellRow, RuleDrawer, SelectionBar, HistoryDrawer, …) keep
// compiling. Fields populated only by the Y.Doc (history, threads,
// attachments, audio timings, validation edits) come back as defaults until
// the respective hooks migrate in Phase 2b. That's deliberate — Phase 2a
// unblocks "see the cells render at all," not full feature parity.

import { useCallback, useEffect, useRef, useState } from "react"
import type * as Y from "yjs"
import type { CellHistoryEntry, SourceLocation, CommentThread, CellTtsSettings } from "@/lib/parsers/types"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"
import type { EditValidationSummary } from "@/lib/codex-editor/edits/types"
import type { CellAuditStats } from "./useCellsAuditStats"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"

export type ValidationStatus = "empty" | "none" | "others" | "self" | "full"

export interface CellData {
  id: string
  fileId: string
  cellLabel?: string
  original: string
  originalHtml?: string
  translated: string
  /** Phase 2a: not populated by useCells — the Tiptap editor still reads
   *  from the per-file Y.Doc via useFileDoc. Phase 2c removes the Y.Doc
   *  entirely. Consumers that need the live fragment should look it up on
   *  the doc directly until then. */
  translatedXml?: Y.XmlFragment
  context: string
  group: string
  /** Optional section label for navigation/progress. */
  section?: string
  globalReferences?: string[]
  type: string
  status: "empty" | "unvalidated" | "validated"
  validationStatus: ValidationStatus
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
      : classifyValidators(activeValidators, username, requiredValidations)

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
    translated,
    context: "",
    group: target?.canonicalRef ?? source?.canonicalRef ?? "",
    type: target?.type ?? source?.type ?? "text",
    status: deriveStatus(translated, validatedForStatus),
    validationStatus,
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

  const doFetch = useCallback(async () => {
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
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = getToken ? await getToken(fileId) : null
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchAllFileCells(projectId, fileId, token)
      if (generationRef.current !== gen) return
      rowsRef.current = rows
      rebuildFromCache()
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCells] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
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
    function onFocus() { void doFetch() }
    function onVis() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void doFetch()
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
    void doFetch()
  }, [doFetch])

  return { cells, revalidate, isLoading, isError }
}
