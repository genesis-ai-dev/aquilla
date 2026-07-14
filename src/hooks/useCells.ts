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
import { streamFileCells, fetchCellsByIds, fetchCellsDelta } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { readCellsCache, writeCellsCache, mergeCellsDelta } from "@/lib/sync/cells-cache"
import { peekOutboxBatch, subscribeToOutbox } from "@/lib/sync/outbox"
import { formatVttTime } from "@/lib/video/vtt-generator"

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

export type ValidationStatus = "empty" | "none" | "others" | "self" | "full" | "full-self" | "full-others"

export interface CellData {
  id: string
  fileId: string
  /** True iff a `target.cell.commit` / `target.cell.create` for this cell is
   *  still sitting in the IndexedDB outbox (offline, retrying, or just enqueued).
   *  When set, `translated` / `translatedHtml` reflect the *pending* value, not
   *  the server projection. UI can render a subtle "queued" indicator. */
  hasPendingEdit?: boolean
  /** Current target head is machine-generated and has not been human-edited or approved. */
  aiDrafted?: boolean
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
  /** Timeline-segment-model (Scope A). Intrinsic order key; fractional ranks
   *  allow inserts between neighbors. Falls back to array index on read. */
  sequenceIndex?: number
  /** Primary content kind. Defaults to `'text'`. */
  medium?: import("@/lib/sync/cells-read-types").SegmentMedium
  /** ASR / corrected source text for a media segment (diverges from target). */
  transcription?: string
  /** Lip-sync camera constraint for a media segment. */
  cameraState?: import("@/lib/sync/cells-read-types").CameraState
  /**
   * Extensible per-cell metadata bucket forwarded from the CellRow projection
   * (e.g. `{ attachments: [{ type:"image", url, alt }] }` for OBS frames). The
   * bucket is side-independent for our use — OBS image attachments live on the
   * source row — so `buildCellData` prefers the source row's metadata and falls
   * back to the target's. Undefined on legacy/plain cells. */
  metadata?: Record<string, unknown> | null
  waivers?: import("@/lib/parsers/types").RuleWaiver[]
  /** Most-recent edit timestamp on the target row (ms epoch). Forwarded from
   *  the CellRow projection so consumers like useLivingMemory can sort by
   *  recency without re-fetching. Undefined for source-only cells or cells
   *  that have never been edited. */
  lastEditAt?: number
}

const EMPTY_STATS: ReadonlyMap<string, CellAuditStats> = new Map()
const EMPTY_VALIDATION_HISTORY: EditValidationSummary[] = []
const EMPTY_HISTORY: CellHistoryEntry[] = []
const EMPTY_THREADS: CommentThread[] = []
const EMPTY_WAIVERS: import("@/lib/parsers/types").RuleWaiver[] = []

function stringArraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return !a?.length && !b?.length
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function waiversEqual(
  a: readonly import("@/lib/parsers/types").RuleWaiver[] | undefined,
  b: readonly import("@/lib/parsers/types").RuleWaiver[] | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return !a?.length && !b?.length
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].ruleId !== b[i].ruleId) return false
    if (a[i].reason !== b[i].reason) return false
    if (a[i].waivedAt !== b[i].waivedAt) return false
    if (a[i].waivedBy !== b[i].waivedBy) return false
  }
  return true
}

function cellsEqual(a: CellData, b: CellData): boolean {
  return (
    a.id === b.id &&
    a.fileId === b.fileId &&
    a.hasPendingEdit === b.hasPendingEdit &&
    a.aiDrafted === b.aiDrafted &&
    a.cellLabel === b.cellLabel &&
    a.original === b.original &&
    a.originalHtml === b.originalHtml &&
    a.translated === b.translated &&
    a.translatedHtml === b.translatedHtml &&
    a.targetEventId === b.targetEventId &&
    a.targetSourceEventId === b.targetSourceEventId &&
    a.sourceEventId === b.sourceEventId &&
    a.context === b.context &&
    a.group === b.group &&
    a.section === b.section &&
    a.type === b.type &&
    a.status === b.status &&
    a.validationStatus === b.validationStatus &&
    a.endorsementCount === b.endorsementCount &&
    a.lastEditAt === b.lastEditAt &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.sequenceIndex === b.sequenceIndex &&
    a.medium === b.medium &&
    a.transcription === b.transcription &&
    a.cameraState === b.cameraState &&
    a.metadata === b.metadata &&
    stringArraysEqual(a.activeValidators, b.activeValidators) &&
    stringArraysEqual(a.globalReferences, b.globalReferences) &&
    waiversEqual(a.waivers, b.waivers)
  )
}

function cellArraysEqual(a: readonly CellData[], b: readonly CellData[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!cellsEqual(a[i], b[i])) return false
  }
  return true
}

function pendingOverlayMapsEqual(
  a: ReadonlyMap<string, { value: string; valueHtml?: string; aiDrafted?: boolean }>,
  b: ReadonlyMap<string, { value: string; valueHtml?: string; aiDrafted?: boolean }>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [cellId, av] of a) {
    const bv = b.get(cellId)
    if (!bv) return false
    if (av.value !== bv.value || av.valueHtml !== bv.valueHtml || av.aiDrafted !== bv.aiDrafted) return false
  }
  return true
}

function classifyValidators(
  active: string[],
  currentUsername: string,
  requiredValidations: number,
): ValidationStatus {
  if (active.length === 0) return "none"
  if (active.length >= requiredValidations) {
    return active.includes(currentUsername) ? "full-self" : "full-others"
  }
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
export function buildCellData(
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
          ? "full-others"
          : "none"

  // Prefer the target row's `validated` flag as the source of truth for the
  // simple "is it green?" UI. When no stats are present, this is the only
  // available signal — D1 encodes the "validators-meet-threshold" gate at the
  // projection layer (AQU-279 made this threshold-aware; AQU-280 aligns all
  // client progress surfaces to consume this flag). Falls back to the
  // activeValidators count only when the server flag is absent (local projects
  // or mid-migration states).
  const validatedForStatus =
    target?.validated ?? activeValidators.length >= requiredValidations

  const startMs = source?.startMs ?? target?.startMs ?? null
  const endMs = source?.endMs ?? target?.endMs ?? null
  const startTime = startMs != null ? startMs / 1000 : undefined
  const endTime = endMs != null ? endMs / 1000 : undefined
  const cueContext =
    startMs != null && endMs != null ? `${formatVttTime(startMs / 1000)} --> ${formatVttTime(endMs / 1000)}` : ""

  // Timeline-segment-model (Scope A): prefer target, fall back to source.
  const sequenceIndex = target?.sequenceIndex ?? source?.sequenceIndex ?? undefined
  const medium = (target?.medium ?? source?.medium ?? "text") as CellData["medium"]
  const transcription = target?.transcription ?? source?.transcription ?? undefined
  const cameraState = (target?.cameraState ?? source?.cameraState ?? undefined) as CellData["cameraState"]

  // Extensible per-cell metadata: OBS image attachments live on the source
  // row, so prefer it; fall back to the target row when only it carries the
  // bucket. Undefined when neither side has metadata.
  const metadata = source?.metadata ?? target?.metadata ?? undefined

  return {
    id: cellId,
    fileId,
    original,
    originalHtml: source?.valueHtml ?? undefined,
    translated,
    translatedHtml: target?.valueHtml ?? undefined,
    aiDrafted: target?.aiDrafted ?? false,
    sourceEventId: source?.eventId,
    targetEventId: target?.eventId,
    targetSourceEventId: target?.sourceEventId ?? null,
    context: cueContext,
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
    lastEditAt: target?.lastEditAt ?? source?.lastEditAt,
    startTime,
    endTime,
    sequenceIndex,
    medium,
    transcription,
    cameraState,
    metadata,
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
  applyOptimisticTargetEdit: (cellId: string, patch: { value: string; valueHtml?: string; aiDrafted?: boolean }) => void
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
  const pendingOverlayRef = useRef<Map<string, { value: string; valueHtml?: string; aiDrafted?: boolean }>>(new Map())
  // Optimistic-edit shadow: a local commit (AI predict, hand edit, promote) that
  // must stay visible even after its outbox event flushes — until a server read
  // actually shows the new value. The outbox overlay above clears the instant
  // the event leaves IDB (flush success), but the server projection is only
  // *visible* once a refetch that POSTDATES the commit lands. On a Bible a full
  // refetch is often already in flight when the commit happens; it snapshotted
  // the target side before the commit, so its atomic buffer swap (doFetch) would
  // otherwise clobber the value with stale-empty data — the disappearing
  // prediction. This shadow bridges that window and self-clears in
  // rebuildFromCache once the projection catches up (value matches).
  //
  // `seq` is the local-mutation clock value at which the shadow was recorded
  // (AQU-247): a fetch may only confirm-and-clear a shadow it provably
  // postdates (fetch startSeq >= shadow seq), so a stale snapshot that
  // coincidentally carries the same value can never clear it.
  const optimisticEditsRef = useRef<Map<string, { value: string; valueHtml?: string; aiDrafted?: boolean; seq: number }>>(new Map())
  // Local-mutation clock (AQU-247). Bumped on every local rowsRef mutation:
  // an optimistic edit, or a targeted revalidateCell write-back. Fetches
  // record the clock when their server snapshot begins; any cell mutated
  // AFTER that point (cellFreshnessRef floor > fetch startSeq) is fresher
  // than the fetch's data, and the fetch must not clobber it. This closes
  // the hole left by the shadow alone: a targeted refetch could confirm and
  // clear the shadow, after which an OLDER still-in-flight full refetch's
  // buffer swap wiped the value/row with pre-commit data (the demo-day
  // "edited cell vanishes until refresh").
  const writeSeqRef = useRef(0)
  const cellFreshnessRef = useRef<Map<string, number>>(new Map())
  // M2-1 delta cursor: MAX(server_seq) over the file's events as of the last
  // confirmed server snapshot (full stream or delta). Non-null ⇒ refetches go
  // through ONE `?since=` request and merge the answer instead of re-streaming
  // the whole file. Null ⇒ full stream (cache miss, pre-M2-1 server/cache
  // entry, or explicit resync). Keyed to the current file — reset on switch.
  const maxServerSeqRef = useRef<number | null>(null)
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
      setCells((prev) => prev.length === 0 ? prev : [])
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
        cell.aiDrafted = o.aiDrafted ?? false
        // Pending edits are by definition unvalidated until they replay
        // through the server projection.
        cell.status = deriveStatus(o.value, false)
        cell.hasPendingEdit = true
      }
    }
    // Optimistic-edit shadow (see optimisticEditsRef). Applied last so it wins
    // over a stale server row. It is NOT pruned here — `rowsRef` is the local
    // cache and is itself mutated to the optimistic value, so it can't tell us
    // the projection caught up. Entries are cleared only by an actual server
    // fetch confirming the value (see clearConfirmedShadows, called from the
    // soft buffer swap and revalidateCell).
    const optimistic = optimisticEditsRef.current
    if (optimistic.size > 0) {
      for (const cell of out) {
        const o = optimistic.get(cell.id)
        if (!o) continue
        cell.translated = o.value
        if (o.valueHtml !== undefined) cell.translatedHtml = o.valueHtml
        cell.aiDrafted = o.aiDrafted ?? false
        cell.status = deriveStatus(o.value, false)
        cell.hasPendingEdit = true
      }
    }
    setCells((prev) => cellArraysEqual(prev, out) ? prev : out)
  }, [])

  // Drop optimistic-edit shadows that a server fetch has confirmed: if the
  // freshly-fetched target row for a shadowed cell already carries the shadow's
  // value, the projection has caught up and the authoritative row should drive
  // the cell. Only real server rows are passed here (never the optimistically
  // mutated rowsRef), so a confirm means the value genuinely round-tripped.
  // `fetchStartSeq` gates confirmation to fetches that postdate the shadow's
  // write — a snapshot taken before the write can't confirm it (AQU-247).
  const clearConfirmedShadows = useCallback((serverRows: CellRow[], fetchStartSeq: number) => {
    const shadows = optimisticEditsRef.current
    if (shadows.size === 0) return
    for (const r of serverRows) {
      if (r.side !== "target") continue
      const o = shadows.get(r.cellId)
      if (o && o.seq <= fetchStartSeq && (r.value ?? "") === o.value) shadows.delete(r.cellId)
    }
  }, [])

  // AQU-247: merge a completed soft-fetch buffer with the rows of any cell
  // mutated locally AFTER the fetch's snapshot began. The buffer predates
  // those mutations, so for each protected cell the current rowsRef rows
  // (optimistic edit or fresher targeted write-back) replace the buffer's —
  // in place, to preserve the anchor-chain order — and sides the stale
  // buffer lacks entirely (first-commit target rows, just-created cells)
  // are appended so the row can't vanish from the table. Cells with a live
  // (unconfirmed) shadow are protected too: an unconfirmed buffer is by
  // definition not fresher than the shadowed write.
  //
  // `discardedCellIds` reports every protected cell whose INCOMING server
  // rows were discarded by the merge (B1). The merged result is then not a
  // faithful image of the server at the fetch's watermark — those rows may
  // carry peer commits the merge dropped — so callers must not advance the
  // `?since=` cursor past them (the next trigger re-delivers the range and
  // merges cleanly once the local floor/shadow clears).
  const mergeProtectedRows = useCallback((
    buffer: CellRow[],
    fetchStartSeq: number,
  ): { rows: CellRow[]; discardedCellIds: Set<string> } => {
    const floors = cellFreshnessRef.current
    const shadows = optimisticEditsRef.current
    const discardedCellIds = new Set<string>()
    if (floors.size === 0 && shadows.size === 0) return { rows: buffer, discardedCellIds }
    const protectedIds = new Set<string>()
    for (const [id, seq] of floors) if (seq > fetchStartSeq) protectedIds.add(id)
    for (const id of shadows.keys()) protectedIds.add(id)
    if (protectedIds.size === 0) return { rows: buffer, discardedCellIds }
    // Current (fresher) rows for protected cells, keyed by cellId|side.
    const keep = new Map<string, CellRow>()
    for (const r of rowsRef.current) {
      if (protectedIds.has(r.cellId)) keep.set(`${r.cellId}|${r.side}`, r)
    }
    const out: CellRow[] = []
    for (const r of buffer) {
      if (!protectedIds.has(r.cellId)) {
        out.push(r)
        continue
      }
      // The incoming server row is discarded either way below (replaced by
      // the fresher local row, or dropped) — record it so the caller holds
      // the watermark back (B1).
      discardedCellIds.add(r.cellId)
      const k = `${r.cellId}|${r.side}`
      const cur = keep.get(k)
      // No current row for this side means a fresher read said it doesn't
      // exist — drop the stale buffer row rather than resurrecting it.
      if (cur) {
        out.push(cur)
        keep.delete(k)
      }
    }
    // Protected rows the stale snapshot never had. Target rows don't drive
    // cell ordering (joinSourceAndTarget orders by source chain), and a
    // missing source row means the cell postdates the snapshot — tail is
    // the best position available until the next fresh fetch.
    for (const r of keep.values()) out.push(r)
    return { rows: out, discardedCellIds }
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
        maxServerSeqRef.current = cached.maxServerSeq ?? null
        rebuildFromCache()
        setIsLoading(false)
        usedCache = true
      } else {
        // CellAreaState drops to `syncing-empty` (skeleton) until the first
        // page lands. No cache ⇒ no delta base — force the full stream.
        rowsRef.current = []
        maxServerSeqRef.current = null
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
      // M2-1 delta path: with a confirmed watermark, ONE `?since=` request
      // replaces the ~60-page full re-stream for every soft revalidate
      // (window focus, visibilitychange, post-commit) and for warm reopens.
      // The merge is in-place via the lib chain-walk, so row order matches a
      // full read — and post-commit rows still flow through rebuildFromCache
      // with their new targetEventId, which is what confirms pending writes
      // in EditorTable. Errors fall to the outer catch: the cached view
      // stays up and the next trigger retries (RES-6).
      const since = maxServerSeqRef.current
      if (since !== null) {
        // Local-mutation clock at snapshot start (AQU-247): rows for any cell
        // mutated after this point outrank the delta's and must survive it.
        const deltaStartSeq = writeSeqRef.current
        const result = await fetchCellsDelta(projectId, fileId, since, token)
        if (generationRef.current !== gen) return
        if (result.kind === "delta") {
          // B1: if the protected-row merge discarded any of the delta's rows
          // (a local write is fresher), the cursor must NOT advance past them
          // — those rows can carry a peer commit the merge dropped, and a
          // cursor beyond it would skip that commit on every future ?since=
          // (split-brain that the IDB cache then persists across reloads).
          // Holding the cursor at `since` costs one re-delivered delta per
          // trigger, only while local edits are actively in flight.
          let nextWatermark = result.maxServerSeq
          if (result.changedCellIds.length > 0) {
            // Confirm shadows against the raw server rows BEFORE the merge,
            // mirroring the full-stream path: only a fetch that postdates a
            // shadow's write may clear it.
            clearConfirmedShadows(result.cells, deltaStartSeq)
            const merged = mergeCellsDelta(rowsRef.current, result.changedCellIds, result.cells)
            const { rows: kept, discardedCellIds } = mergeProtectedRows(merged, deltaStartSeq)
            rowsRef.current = kept
            rebuildFromCache()
            if (discardedCellIds.size > 0) nextWatermark = since
            void writeCellsCache(projectId, fileId, rowsRef.current, nextWatermark)
          } else if (result.maxServerSeq !== since) {
            // Watermark moved on row-less events (file.rename etc.) — advance
            // the cursor so those events aren't re-scanned forever.
            void writeCellsCache(projectId, fileId, rowsRef.current, result.maxServerSeq)
          }
          maxServerSeqRef.current = nextWatermark
          setIsLoading(false)
          return
        }
        // kind === "resync": the changed set outgrew the delta budget, or the
        // server predates ?since=. Fall through to the full stream below.
      }
      // Stream pages in: on a hard fetch, append each page in place and rebuild
      // ONCE on the first page so the first 500 rows paint immediately on
      // Bible-sized files (~30k cells × ~60 round-trips); the final rebuild
      // below swaps in the rest. On a soft refetch, accumulate into a buffer
      // and swap it in once at the end so the visible list never flickers (and
      // never shrink-then-grows across pages). The `gen` fence aborts the
      // stream if the caller switches files mid-flight.
      const buffer: CellRow[] = []
      // Paint the FIRST page that asks for a rebuild (the first source page) so
      // the empty state never flashes, then defer: the unconditional final
      // rebuild after both streams (below) swaps in the complete list once.
      // Rebuilding on every page was O(pages × cells) — the dominant cost of a
      // ~60-page Bible-sized first open.
      let paintedFirstPage = false
      const pushRows = (rows: CellRow[], rebuild: boolean): boolean | void => {
        if (generationRef.current !== gen) return false
        if (rows.length === 0) return
        if (effectiveSoft) {
          for (const r of rows) buffer.push(r)
          return
        }
        // Append in place. The old `concat` minted a fresh array every page,
        // which is O(N^2) across the stream. On the hard path rowsRef.current
        // is always the owned `[]` seeded above (cache hits and resyncs take
        // the effectiveSoft buffer path), so mutating it in place is safe.
        for (const r of rows) rowsRef.current.push(r)
        if (rebuild && !paintedFirstPage) {
          paintedFirstPage = true
          rebuildFromCache()
        }
      }
      // AQU-247: the local-mutation clock at the moment the server snapshot
      // begins. Any cell mutated after this point is fresher than this
      // fetch's data — it can neither confirm that cell's shadow nor replace
      // its rows at the swap below.
      const startSeq = writeSeqRef.current
      // Stream the TARGET side first. The combined read returns every source
      // row before any target row, so on a Bible-sized file (~30k source cells
      // vs. a handful of translated target cells) fetching both sides at once
      // hides every translation behind the entire ~60-page source stream —
      // committed edits look lost on reload until the whole file loads. The
      // target side is tiny (one page), so loading it up front means a
      // translated cell shows its value the moment its source row paints.
      // Seed it silently (no rebuild) so we don't flash target-only orphan rows.
      //
      // The TARGET stream's first page carries the earliest watermark of the
      // whole two-stream snapshot — the safe `?since=` cursor: anything that
      // lands mid-stream has a higher seq, so the next delta re-fetches it.
      //
      // B2 (torn snapshot): the server paginates by OFFSET, so a row that
      // shifts across a page boundary while the stream is in flight can be
      // skipped entirely — and a skipped-but-unchanged cell is never
      // re-delivered by any later delta. The tell is a page-to-page
      // `maxServerSeq` bump within a side-stream; when seen, the snapshot's
      // rows are kept (better than blanking) but NO cursor is stored, so the
      // next trigger full-streams once and self-heals.
      let streamMaxSeq: number | null = null
      let streamTorn = false
      let cursorSeen = false
      const trackStreamMeta = () => {
        let sideFirst: number | null = null
        let sideSeen = false
        return (meta: { maxServerSeq?: number | null }) => {
          const v = typeof meta.maxServerSeq === "number" ? meta.maxServerSeq : null
          if (!cursorSeen) {
            cursorSeen = true
            streamMaxSeq = v
          }
          if (!sideSeen) {
            sideSeen = true
            sideFirst = v
          } else if (v !== sideFirst) {
            streamTorn = true
          }
        }
      }
      await streamFileCells(
        projectId,
        fileId,
        token,
        (rows) => pushRows(rows, false),
        "target",
        trackStreamMeta(),
      )
      if (generationRef.current !== gen) return
      await streamFileCells(
        projectId,
        fileId,
        token,
        (rows) => pushRows(rows, true),
        "source",
        trackStreamMeta(),
      )
      if (generationRef.current !== gen) return
      let discardedProtected = false
      if (effectiveSoft) {
        // Confirm shadows against the SERVER buffer before it becomes rowsRef,
        // so a stale buffer (target snapshotted pre-commit) does NOT confirm
        // (and thus does not clear) an optimistic edit it predates.
        clearConfirmedShadows(buffer, startSeq)
        // Swap in the buffer, retaining rows for any cell mutated locally
        // after this fetch's snapshot began (AQU-247).
        const { rows: kept, discardedCellIds } = mergeProtectedRows(buffer, startSeq)
        rowsRef.current = kept
        discardedProtected = discardedCellIds.size > 0
      }
      // Final rebuild: the source pass paints per page, but a target-only or
      // empty-source file yields no source page to trigger one — and the
      // target seed pass is intentionally silent. This also swaps in the soft
      // buffer. Cheap and idempotent on the hard path.
      rebuildFromCache()
      // Persist the freshly-loaded snapshot (+ its delta cursor). Best-effort;
      // failures are swallowed inside writeCellsCache so a hostile IDB never
      // breaks the load path.
      //
      // B1/B2: a torn stream, or a swap that discarded protected rows, is not
      // a faithful server image at any single seq — store NO cursor so the
      // next trigger full-streams once and self-heals.
      const watermark = streamTorn || discardedProtected ? null : streamMaxSeq
      maxServerSeqRef.current = watermark
      void writeCellsCache(projectId, fileId, rowsRef.current, watermark ?? undefined)
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
  }, [rebuildFromCache, clearConfirmedShadows, mergeProtectedRows])

  // Reload on (projectId, fileId, enabled) change. The optimistic-edit shadow
  // and freshness floors are per-file local state — drop them so edits from
  // the previous file can't bleed onto a same-id cell in the next one.
  useEffect(() => {
    optimisticEditsRef.current.clear()
    cellFreshnessRef.current.clear()
    // The delta cursor belongs to the previous file's event log.
    maxServerSeqRef.current = null
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
  //
  // AQU-274: `failed` (quarantined) records are EXCLUDED from the overlay so a
  // 403-rejected commit no longer pins the rejected text as live cell content.
  // They remain visible in the outbox inspector (usePendingOutboxRecords keeps
  // all statuses for that purpose). When a record transitions to `failed`, we
  // also clear its optimistic shadow so the cell reverts to the server value
  // instead of showing the rejected text indefinitely. The write-clock is
  // respected: we only clear the shadow for the specific cellId whose event
  // failed — other cells' shadows are unaffected.
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
      const next = new Map<string, { value: string; valueHtml?: string; aiDrafted?: boolean }>()
      let shadowChanged = false
      for (const r of all) {
        if (fid && r.event.fileId !== fid) continue
        const k = r.event.kind
        if (k !== "target.cell.commit" && k !== "target.cell.create") continue
        const cellId = r.event.cellId
        if (!cellId) continue
        // AQU-274: skip quarantined (failed) records — they must not drive cell
        // content in the overlay; the inspector still shows them.
        if ((r.status ?? "pending") === "failed") {
          // Clear the optimistic shadow for this cell so it reverts to the
          // server projection. Respect the write-clock: only clear if no
          // NEWER own-write for this cell has been recorded after the
          // quarantined event — if a newer write exists, its shadow should
          // stay authoritative until confirmed by a postdating server read.
          const shadow = optimisticEditsRef.current.get(cellId)
          const p = r.event.payload as { value?: string }
          if (shadow && typeof p.value === "string" && shadow.value === p.value) {
            // The shadow still holds the same rejected value — clear it so the
            // cell reverts to the server projection. A different value means
            // the user already made a superseding edit; leave that shadow alone.
            optimisticEditsRef.current.delete(cellId)
            shadowChanged = true
          }
          continue
        }
        const p = r.event.payload as { value?: string; valueHtml?: string; ai_suggestion?: true }
        if (typeof p.value !== "string") continue
        next.set(cellId, { value: p.value, valueHtml: p.valueHtml, aiDrafted: p.ai_suggestion === true })
      }
      const overlayChanged = !pendingOverlayMapsEqual(pendingOverlayRef.current, next)
      if (overlayChanged) pendingOverlayRef.current = next
      if (overlayChanged || shadowChanged) rebuildFromCache()
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

  // Revalidate on focus / visibility return so a peer's commit becomes
  // visible without a manual reload. Since M2-1 this is NOT a full re-stream:
  // doFetch(true) goes through the `?since=` delta path whenever a watermark
  // exists, so alt-tabbing back to a Bible-sized book costs one tiny request
  // instead of ~60 full pages (PERF-4).
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

  const refreshCellsCacheFromRows = useCallback(() => {
    const projectId = projectRef.current
    const fileId = fileRef.current
    if (!projectId || !fileId) return
    void writeCellsCache(projectId, fileId, rowsRef.current, maxServerSeqRef.current ?? undefined)
  }, [])

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
  // Self-reference so the discard-exhaustion path below can re-kick a fresh
  // targeted fetch after the in-flight marker clears (a useCallback can't
  // name itself). Assigned right after the declaration, render-time, same as
  // the other refs above.
  const revalidateCellRef = useRef<(cellId: string) => void>(() => {})
  const revalidateCell = useCallback((cellId: string) => {
    const projectId = projectRef.current
    const fileId = fileRef.current
    const enabled = enabledRef.current
    const getToken = tokenFetcherRef.current
    if (!enabled || !projectId || !fileId || !getToken) return
    if (cellFetchInFlightRef.current.has(cellId)) return
    cellFetchInFlightRef.current.add(cellId)
    const gen = generationRef.current
    // True when the loop's final attempt was discarded because a local
    // mutation outpaced it — the finally block then re-kicks a fresh call
    // (new startSeq) so the cell can't sit unconfirmed until the next WS
    // poke. Each re-kick needs yet another mid-flight mutation to be
    // discarded again, so this converges as soon as edits pause.
    let exhaustedByDiscard = false
    void (async () => {
      try {
        const token = await getToken(fileId)
        if (!token) return
        // Bounded retry (AQU-247): if a local mutation lands while the fetch
        // is in flight, the response predates it and is discarded — try once
        // more against the newer state rather than stranding the cell until
        // the next WS poke / focus refetch.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (generationRef.current !== gen) return
          const startSeq = writeSeqRef.current
          const rows = await fetchCellsByIds(projectId, fileId, [cellId], token)
          if (generationRef.current !== gen) return
          if (projectRef.current !== projectId || fileRef.current !== fileId) return
          const floor = cellFreshnessRef.current.get(cellId)
          if (floor !== undefined && floor > startSeq) {
            exhaustedByDiscard = true
            continue
          }
          exhaustedByDiscard = false
          // A targeted server read — clear the shadow if it confirms the value.
          clearConfirmedShadows(rows, startSeq)
          // The write-back is itself a local mutation: any full fetch whose
          // snapshot began before now must not overwrite it at its swap.
          cellFreshnessRef.current.set(cellId, ++writeSeqRef.current)
          // Replace this cellId's rows IN PLACE — rows arrive as one source +
          // one target (either may be absent). The cell list renders in row
          // order, so filter-and-append would teleport the edited row to the
          // bottom of the file (AQU-247's "row disappears"). A side the
          // server no longer returns is dropped; a side the cache never had
          // (first commit's target row) appends at the tail, which doesn't
          // affect ordering (cells order by their source rows).
          const bySide = new Map(rows.map((r) => [r.side, r]))
          const next: CellRow[] = []
          for (const r of rowsRef.current) {
            if (r.cellId !== cellId) {
              next.push(r)
              continue
            }
            const repl = bySide.get(r.side)
            if (repl) {
              next.push(repl)
              bySide.delete(r.side)
            }
          }
          for (const r of bySide.values()) next.push(r)
          rowsRef.current = next
          rebuildFromCache()
          refreshCellsCacheFromRows()
          return
        }
      } catch {
        // Targeted fetch failed — fall back to the full file refetch so
        // we never strand stale local state on a transient network blip.
        exhaustedByDiscard = false
        if (generationRef.current === gen) void doFetch(true)
      } finally {
        cellFetchInFlightRef.current.delete(cellId)
        if (
          exhaustedByDiscard &&
          generationRef.current === gen &&
          projectRef.current === projectId &&
          fileRef.current === fileId
        ) {
          revalidateCellRef.current(cellId)
        }
      }
    })()
  }, [doFetch, rebuildFromCache, clearConfirmedShadows, refreshCellsCacheFromRows])
  revalidateCellRef.current = revalidateCell

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
    (cellId: string, patch: { value: string; valueHtml?: string; aiDrafted?: boolean }) => {
      // Record the shadow so a stale in-flight refetch's buffer swap can't wipe
      // this value before the projection catches up (see optimisticEditsRef).
      // The seq stamps this write on the local-mutation clock: only a fetch
      // whose snapshot began at-or-after it may confirm the shadow, and any
      // fetch that began before it must keep this cell's rows at its swap.
      const seq = ++writeSeqRef.current
      optimisticEditsRef.current.set(cellId, { value: patch.value, valueHtml: patch.valueHtml, aiDrafted: patch.aiDrafted ?? false, seq })
      cellFreshnessRef.current.set(cellId, seq)
      const rows = rowsRef.current
      let touched = false
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.cellId !== cellId || r.side !== "target") continue
        rows[i] = { ...r, value: patch.value, valueHtml: patch.valueHtml ?? null, aiDrafted: patch.aiDrafted ?? false }
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
          aiDrafted: patch.aiDrafted ?? false,
          wordCount: patch.value.trim() ? patch.value.trim().split(/\s+/).length : 0,
        })
      }
      rebuildFromCache()
    },
    [rebuildFromCache],
  )

  return { cells, revalidate, revalidateCell, applyOptimisticTargetEdit, isLoading, isError }
}
