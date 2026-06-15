import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { CellData } from "./useCells"
import { buildCellData } from "./useCells"
import type { CellAuditStats } from "./useCellsAuditStats"
import { streamFileCells, fetchCellsByIds, fetchCellsDelta } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { mergeCellsDelta, readCellsCache, writeCellsCache } from "@/lib/sync/cells-cache"
import { peekOutboxBatch, subscribeToOutbox } from "@/lib/sync/outbox"
import { extractUsfmFootnotes, type ExtractedFootnote } from "@/lib/footnotes/extract"
import { sortByLens } from "@/lib/timeline/derive"
import type { OrderedBy, RuleWaiver } from "@/lib/parsers/types"
import type { FileProgressResponse, ProgressCounts } from "@/lib/progress/file-progress-resource"

const EMPTY_STATS: ReadonlyMap<string, CellAuditStats> = new Map()
const EMPTY_CELL_IDS: readonly string[] = Object.freeze([])
const EMPTY_SUMMARIES: readonly CellSummary[] = Object.freeze([])
const EMPTY_TEXT_PAIRS: readonly CellTextPair[] = Object.freeze([])
const EMPTY_NAVIGATION: readonly CellNavigationEntry[] = Object.freeze([])
const EMPTY_FOOTNOTES: ExtractedFootnote[] = []
const EMPTY_FOOTNOTE_DETAILS: CellFootnoteDetails = Object.freeze({
  sourceFootnotes: EMPTY_FOOTNOTES,
  targetFootnotes: EMPTY_FOOTNOTES,
  sourceCount: 0,
  targetCount: 0,
  hasFootnotes: false,
})

export type CellViewModel = CellData

export interface CellSummary {
  id: string
  fileId: string
  index: number
  cellLabel?: string
  original: string
  translated: string
  originalHtml?: string
  translatedHtml?: string
  context: string
  group: string
  section?: string
  globalReferences?: string[]
  type: string
  status: CellData["status"]
  validationStatus: CellData["validationStatus"]
  activeValidators: string[]
  validated: boolean
  endorsementCount?: number
  sourceEventId?: string
  targetEventId?: string
  targetSourceEventId?: string | null
  aiDrafted?: boolean
  lastEditAt?: number
  startTime?: number
  endTime?: number
  sequenceIndex?: number
  medium?: CellData["medium"]
  selectedGeneratedVoiceAudioId?: string
}

export interface CellTextPair {
  cellId: string
  fileId: string
  sourceText: string
  targetText: string
  validated: boolean
  index: number
}

export interface CellCommitHandle {
  projectId: string
  fileId: string
  cellId: string
  parentId: string | null
  sourceEventId: string | null
}

export interface CellNavigationEntry {
  label: string
  firstCellId: string
  firstIndex: number
  translated: number
  validated: number
  total: number
}

export interface CellFootnoteDetails {
  sourceFootnotes: ExtractedFootnote[]
  targetFootnotes: ExtractedFootnote[]
  sourceCount: number
  targetCount: number
  hasFootnotes: boolean
}

export interface CellDetailsSummary {
  id: string
  fileId: string
  index: number
  sourceText: string
  targetText: string
  sourceHtml?: string
  targetHtml?: string
  status: CellData["status"]
  validationStatus: CellData["validationStatus"]
  activeValidators: string[]
  hasTargetText: boolean
  endorsementCount?: number
  sourceEventId?: string
  targetEventId?: string
  targetSourceEventId?: string | null
  lastEditAt?: number
  startTime?: number
  endTime?: number
  sequenceIndex?: number
  medium?: CellData["medium"]
  sourceFootnoteCount: number
  targetFootnoteCount: number
  hasSourceFootnotes: boolean
  hasTargetFootnotes: boolean
}

export interface CellBacktranslationState {
  cellId: string
  targetText: string
  targetEventId: string | null
  hasTargetText: boolean
  savedText: string
  hasSaved: boolean
  stale: boolean
}

interface RuntimeContext {
  projectId: string | null
  fileId: string | null
  username: string
  requiredValidations: number
  auditStats: ReadonlyMap<string, CellAuditStats>
}

interface PendingOverlay {
  value: string
  valueHtml?: string
  eventId?: string
  aiDrafted?: boolean
}

interface OptimisticEdit extends PendingOverlay {
  seq: number
}

interface DerivedCache {
  baseVersion: number
  summaries: CellSummary[]
  textPairs: CellTextPair[]
}

export class CellStore {
  private ctx: RuntimeContext = {
    projectId: null,
    fileId: null,
    username: "local",
    requiredValidations: 1,
    auditStats: EMPTY_STATS,
  }

  private order: string[] = []
  private sourceOrder: string[] = []
  private targetOrder: string[] = []
  private indexById = new Map<string, number>()
  private sourceById = new Map<string, CellRow>()
  private targetById = new Map<string, CellRow>()
  private pendingOverlay = new Map<string, PendingOverlay>()
  private pendingProgressEventIds: string[] = []
  private optimisticEdits = new Map<string, OptimisticEdit>()
  private freshnessFloors = new Map<string, number>()
  private cellVersionById = new Map<string, number>()
  // Feeds per-cell versions from one store-lifetime counter that reset() never
  // rewinds. useSyncExternalStore bails out when getCellVersion returns a value
  // the row already rendered with, so a version number may never be reused: a
  // per-cell counter that restarts at 0 on reset() can silently re-inflate
  // (bumpAllCells on audit-stats churn notifies only the audit-changed cells)
  // and land a real data change on an already-seen number — the row then stays
  // stale until remount.
  private versionCounter = 0
  private cellListeners = new Map<string, Set<() => void>>()
  private listListeners = new Set<() => void>()
  private allListeners = new Set<() => void>()
  private listVersion = 0
  private fileVersion = 0
  private derivedVersion = 0
  private writeSeq = 0
  private maxServerSeq: number | null = null
  private navIndex: CellNavigationEntry[] = []
  private fileProgressSnapshot: FileProgressResponse | null = null
  private sectionLabelById = new Map<string, string>()
  private footnoteOffsets = new Map<string, { source: number; target: number }>()
  private footnoteCache = new Map<string, {
    sourceText: string
    targetText: string
    details: CellFootnoteDetails
  }>()
  private derivedCache: DerivedCache = { baseVersion: -1, summaries: [], textPairs: [] }

  setRuntime(next: RuntimeContext): void {
    const prevStats = this.ctx.auditStats
    const statsChanged = prevStats !== next.auditStats
    const userChanged = this.ctx.username !== next.username || this.ctx.requiredValidations !== next.requiredValidations
    this.ctx = next
    if (statsChanged || userChanged) {
      // Invariant: a per-cell version bump is ALWAYS paired with a per-cell
      // emit of the same set. Editor rows read useSyncExternalStore over
      // getCellVersion; a bump without an emit lets a parent-driven render
      // consume the new version number with the data of that moment, and any
      // later same-version data change looks like "no change" to React — the
      // row then stays stale until remount. The old bumpAllCells()-but-emit-
      // only-the-changed-cells shape here was exactly that: audit-stats churn
      // during a batch silently inflated every cell's version.
      if (userChanged) {
        this.bumpAllCells()
        this.rebuildDerivedIndexes()
        this.emit(this.order)
        return
      }
      const changed = diffChangedAuditCellIds(prevStats, next.auditStats)
      this.bumpCells(changed)
      this.fileVersion++
      this.rebuildDerivedIndexes()
      if (changed.size > 0) {
        this.emit(changed) // per-cell + list + all listeners
      } else {
        this.emitAll()
      }
    }
  }

  reset(projectId: string | null, fileId: string | null): void {
    this.ctx = { ...this.ctx, projectId, fileId }
    // Rows still subscribed to the outgoing cells must hear about the reset —
    // emitAll() alone only wakes subscribeAll consumers (footer/table shell),
    // and a per-cell subscriber left unnotified keeps rendering the old file's
    // content until something else touches its cell.
    const clearedIds = this.order
    this.order = []
    this.sourceOrder = []
    this.targetOrder = []
    this.indexById = new Map()
    this.sourceById = new Map()
    this.targetById = new Map()
    this.pendingOverlay = new Map()
    this.pendingProgressEventIds = []
    this.optimisticEdits = new Map()
    this.freshnessFloors = new Map()
    this.cellVersionById = new Map()
    this.maxServerSeq = null
    this.writeSeq = 0
    this.footnoteCache = new Map()
    this.rebuildDerivedIndexes()
    this.listVersion++
    this.fileVersion++
    this.emit(clearedIds)
  }

  subscribeList = (listener: () => void): (() => void) => {
    this.listListeners.add(listener)
    return () => this.listListeners.delete(listener)
  }

  subscribeAll = (listener: () => void): (() => void) => {
    this.allListeners.add(listener)
    return () => this.allListeners.delete(listener)
  }

  subscribeCell = (cellId: string, listener: () => void): (() => void) => {
    let set = this.cellListeners.get(cellId)
    if (!set) {
      set = new Set()
      this.cellListeners.set(cellId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.cellListeners.delete(cellId)
    }
  }

  getListVersion = (): number => this.listVersion
  getAllVersion = (): number => this.fileVersion
  getCellVersion = (cellId: string): number => this.cellVersionById.get(cellId) ?? 0
  getFileId = (): string | null => this.ctx.fileId
  getProjectId = (): string | null => this.ctx.projectId
  getCellCount = (): number => this.order.length
  getMaxServerSeq = (): number | null => this.maxServerSeq
  setMaxServerSeq(seq: number | null): void {
    this.maxServerSeq = seq
    if (this.fileProgressSnapshot) {
      this.fileProgressSnapshot = { ...this.fileProgressSnapshot, revision: seq ?? 0 }
    }
  }
  getWriteSeq = (): number => this.writeSeq
  getFreshnessFloor = (cellId: string): number | undefined => this.freshnessFloors.get(cellId)

  getCellIds(): readonly string[] {
    return this.order.length === 0 ? EMPTY_CELL_IDS : this.order
  }

  getCellIdsForLens(orderedBy?: OrderedBy, mediaLayer = false): readonly string[] {
    if (this.order.length === 0) return EMPTY_CELL_IDS
    if (orderedBy !== "time") return this.order
    const rows = this.order
      .map((id) => {
        const summary = this.getCellSummary(id)
        return summary ? {
          id,
          startTime: summary.startTime,
          endTime: summary.endTime,
          sequenceIndex: summary.sequenceIndex,
          medium: summary.medium,
        } : null
      })
      .filter((item): item is NonNullable<typeof item> => {
        if (!item) return false
        return mediaLayer ? item.medium === "media" : (item.medium ?? "text") !== "media"
      })
    return sortByLens(rows, "time").map((row) => row.id)
  }

  findIndexByCellId(cellId: string): number {
    return this.indexById.get(cellId) ?? -1
  }

  findIndexBySection(label: string): number {
    const entry = this.navIndex.find((item) => item.label === label)
    return entry?.firstIndex ?? -1
  }

  getSectionLabelForCellId(cellId: string | undefined | null): string {
    if (!cellId) return ""
    return this.sectionLabelById.get(cellId) ?? ""
  }

  getNavigationIndex(): readonly CellNavigationEntry[] {
    return this.navIndex.length === 0 ? EMPTY_NAVIGATION : this.navIndex
  }

  getFileProgressSnapshot(): FileProgressResponse | null {
    return this.fileProgressSnapshot
  }

  getPendingProgressEventIds(): readonly string[] {
    return this.pendingProgressEventIds
  }

  getFootnoteOffsets(cellId: string): { source: number; target: number } {
    return this.footnoteOffsets.get(cellId) ?? { source: 0, target: 0 }
  }

  getCellFootnotes(cellId: string): CellFootnoteDetails {
    const sourceText = this.sourceById.get(cellId)?.value ?? ""
    const targetText = this.targetById.get(cellId)?.value ?? ""
    if (!sourceText.includes("\\f") && !targetText.includes("\\f")) {
      this.footnoteCache.delete(cellId)
      return EMPTY_FOOTNOTE_DETAILS
    }
    const cached = this.footnoteCache.get(cellId)
    if (cached && cached.sourceText === sourceText && cached.targetText === targetText) {
      return cached.details
    }
    const sourceFootnotes = extractUsfmFootnotes(sourceText)
    const targetFootnotes = extractUsfmFootnotes(targetText)
    const details: CellFootnoteDetails = {
      sourceFootnotes,
      targetFootnotes,
      sourceCount: sourceFootnotes.length,
      targetCount: targetFootnotes.length,
      hasFootnotes: sourceFootnotes.length > 0 || targetFootnotes.length > 0,
    }
    this.footnoteCache.set(cellId, { sourceText, targetText, details })
    return details
  }

  getCellView(cellId: string): CellViewModel | null {
    if (!this.indexById.has(cellId)) return null
    const source = this.sourceById.get(cellId)
    const target = this.targetById.get(cellId)
    const cell = buildCellData(
      cellId,
      source,
      target,
      this.ctx.fileId ?? "",
      this.ctx.username,
      this.ctx.requiredValidations,
      this.ctx.auditStats.get(cellId),
    )
    this.applyContentOverlays(cell)
    return cell
  }

  getCellDetailsSummary(cellId: string): CellDetailsSummary | null {
    const index = this.indexById.get(cellId)
    if (index == null) return null
    const source = this.sourceById.get(cellId)
    const target = this.targetById.get(cellId)
    if (!source && !target) return null
    const sourceText = source?.value ?? ""
    const targetText = target?.value ?? ""
    const audit = this.ctx.auditStats.get(cellId)
    const activeValidators = audit?.activeValidators ?? []
    const validated = target?.validated ?? false
    const status = deriveStatus(targetText, validated)
    const footnotes = this.getCellFootnotes(cellId)
    return {
      id: cellId,
      fileId: this.ctx.fileId ?? "",
      index,
      sourceText,
      targetText,
      ...(source?.valueHtml ? { sourceHtml: source.valueHtml } : {}),
      ...(target?.valueHtml ? { targetHtml: target.valueHtml } : {}),
      status,
      validationStatus: deriveValidationStatus(status, activeValidators, this.ctx.username, this.ctx.requiredValidations),
      activeValidators,
      hasTargetText: targetText.trim().length > 0,
      endorsementCount: target?.endorsementCount ?? source?.endorsementCount,
      sourceEventId: source?.eventId,
      targetEventId: target?.eventId,
      targetSourceEventId: target?.sourceEventId,
      lastEditAt: target?.lastEditAt ?? source?.lastEditAt,
      startTime: target?.startMs ?? source?.startMs ?? undefined,
      endTime: target?.endMs ?? source?.endMs ?? undefined,
      sequenceIndex: target?.sequenceIndex ?? source?.sequenceIndex ?? undefined,
      medium: (target?.medium ?? source?.medium ?? undefined) as CellData["medium"],
      sourceFootnoteCount: footnotes.sourceCount,
      targetFootnoteCount: footnotes.targetCount,
      hasSourceFootnotes: footnotes.sourceCount > 0,
      hasTargetFootnotes: footnotes.targetCount > 0,
    }
  }

  getCellBacktranslationState(
    cellId: string,
    savedText = "",
    savedTargetEventId?: string | null,
  ): CellBacktranslationState | null {
    const target = this.targetById.get(cellId)
    const targetText = target?.value ?? ""
    if (!this.indexById.has(cellId)) return null
    return {
      cellId,
      targetText,
      targetEventId: target?.eventId ?? null,
      hasTargetText: targetText.trim().length > 0,
      savedText,
      hasSaved: savedText.trim().length > 0,
      stale: Boolean(savedText.trim() && savedTargetEventId && target?.eventId && savedTargetEventId !== target.eventId),
    }
  }

  getCellSummary(cellId: string): CellSummary | null {
    const index = this.indexById.get(cellId)
    if (index == null) return null
    const view = this.getCellView(cellId)
    if (!view) return null
    return {
      id: view.id,
      fileId: view.fileId,
      index,
      cellLabel: view.cellLabel,
      original: view.original,
      translated: view.translated,
      originalHtml: view.originalHtml,
      translatedHtml: view.translatedHtml,
      context: view.context,
      group: view.group,
      section: view.section,
      globalReferences: view.globalReferences,
      type: view.type,
      status: view.status,
      validationStatus: view.validationStatus,
      activeValidators: view.activeValidators,
      validated: view.status === "validated",
      endorsementCount: view.endorsementCount,
      sourceEventId: view.sourceEventId,
      targetEventId: view.targetEventId,
      targetSourceEventId: view.targetSourceEventId,
      aiDrafted: view.aiDrafted,
      lastEditAt: view.lastEditAt,
      startTime: view.startTime,
      endTime: view.endTime,
      sequenceIndex: view.sequenceIndex,
      medium: view.medium,
      selectedGeneratedVoiceAudioId: view.selectedGeneratedVoiceAudioId,
    }
  }

  getCommitHandle(cellId: string): CellCommitHandle | null {
    if (!this.ctx.projectId || !this.ctx.fileId) return null
    const source = this.sourceById.get(cellId)
    const target = this.targetById.get(cellId)
    if (!source && !target) return null
    return {
      projectId: this.ctx.projectId,
      fileId: this.ctx.fileId,
      cellId,
      parentId: target?.eventId || source?.eventId || null,
      sourceEventId: source?.eventId ?? null,
    }
  }

  getRange(start: number, end: number): CellViewModel[] {
    return this.order
      .slice(Math.max(0, start), Math.max(0, end))
      .map((id) => this.getCellView(id))
      .filter((cell): cell is CellViewModel => cell !== null)
  }

  getCellsByIds(ids: Iterable<string>): CellViewModel[] {
    const out: CellViewModel[] = []
    for (const id of ids) {
      const cell = this.getCellView(id)
      if (cell) out.push(cell)
    }
    return out
  }

  getAllCellViews(): CellViewModel[] {
    return this.getCellsByIds(this.order)
  }

  getAllSummaries(): readonly CellSummary[] {
    this.ensureDerivedCache()
    return this.derivedCache.summaries.length === 0 ? EMPTY_SUMMARIES : this.derivedCache.summaries
  }

  getTextPairs(): readonly CellTextPair[] {
    this.ensureDerivedCache()
    return this.derivedCache.textPairs.length === 0 ? EMPTY_TEXT_PAIRS : this.derivedCache.textPairs
  }

  replaceRows(rows: CellRow[], opts: { maxServerSeq?: number | null; changedCellIds?: Iterable<string>; full?: boolean } = {}): void {
    const changedIds = opts.full ? new Set<string>(this.order) : new Set(opts.changedCellIds ?? [])
    const sourceById = new Map<string, CellRow>()
    const targetById = new Map<string, CellRow>()
    const sourceOrder: string[] = []
    const targetOrder: string[] = []

    for (const row of rows) {
      if (row.side === "source") {
        if (!sourceById.has(row.cellId)) {
          sourceOrder.push(row.cellId)
          changedIds.add(row.cellId)
        }
        sourceById.set(row.cellId, row)
      } else {
        if (!targetById.has(row.cellId)) targetOrder.push(row.cellId)
        targetById.set(row.cellId, row)
        changedIds.add(row.cellId)
      }
    }

    const seen = new Set(sourceOrder)
    const order = [...sourceOrder]
    for (const id of targetOrder) {
      if (!seen.has(id)) order.push(id)
    }

    if (!sameStringArray(order, this.order)) {
      for (const id of this.order) changedIds.add(id)
      for (const id of order) changedIds.add(id)
      this.listVersion++
    }

    this.order = order
    this.sourceOrder = sourceOrder
    this.targetOrder = targetOrder
    this.sourceById = sourceById
    this.targetById = targetById
    this.indexById = new Map(order.map((id, index) => [id, index]))
    const liveIds = new Set(order)
    for (const id of this.footnoteCache.keys()) {
      if (!liveIds.has(id)) this.footnoteCache.delete(id)
    }
    if (opts.maxServerSeq !== undefined) this.maxServerSeq = opts.maxServerSeq
    this.rebuildDerivedIndexes()
    this.bumpCells(changedIds)
    this.fileVersion++
    this.emit(changedIds)
  }

  replaceChangedRows(changedCellIds: string[], rows: CellRow[], maxServerSeq?: number): void {
    const merged = mergeCellsDelta(this.toRows(), changedCellIds, rows)
    this.replaceRows(merged, { changedCellIds, maxServerSeq })
  }

  toRows(): CellRow[] {
    const rows: CellRow[] = []
    for (const id of this.sourceOrder) {
      const row = this.sourceById.get(id)
      if (row) rows.push(row)
    }
    for (const id of this.targetOrder) {
      const row = this.targetById.get(id)
      if (row) rows.push(row)
    }
    return rows
  }

  clearConfirmedShadows(serverRows: CellRow[], fetchStartSeq: number): void {
    if (this.optimisticEdits.size === 0) return
    const changed = new Set<string>()
    for (const row of serverRows) {
      if (row.side !== "target") continue
      const shadow = this.optimisticEdits.get(row.cellId)
      if (shadow && shadow.seq <= fetchStartSeq && (row.value ?? "") === shadow.value) {
        this.optimisticEdits.delete(row.cellId)
        changed.add(row.cellId)
      }
    }
    if (changed.size > 0) {
      this.bumpCells(changed)
      this.rebuildDerivedIndexes()
      this.emit(changed)
    }
  }

  mergeProtectedRows(buffer: CellRow[], fetchStartSeq: number): { rows: CellRow[]; discardedCellIds: Set<string> } {
    const protectedIds = new Set<string>()
    for (const [id, seq] of this.freshnessFloors) if (seq > fetchStartSeq) protectedIds.add(id)
    for (const id of this.optimisticEdits.keys()) protectedIds.add(id)
    const discardedCellIds = new Set<string>()
    if (protectedIds.size === 0) return { rows: buffer, discardedCellIds }

    const keep = new Map<string, CellRow>()
    for (const row of this.toRows()) {
      if (protectedIds.has(row.cellId)) keep.set(`${row.cellId}|${row.side}`, row)
    }

    const out: CellRow[] = []
    for (const row of buffer) {
      if (!protectedIds.has(row.cellId)) {
        out.push(row)
        continue
      }
      discardedCellIds.add(row.cellId)
      const key = `${row.cellId}|${row.side}`
      const current = keep.get(key)
      if (current) {
        out.push(current)
        keep.delete(key)
      }
    }
    for (const row of keep.values()) out.push(row)
    return { rows: out, discardedCellIds }
  }

  setPendingOverlay(next: Map<string, PendingOverlay>): void {
    const changed = symmetricChangedKeys(
      this.pendingOverlay,
      next,
      (a, b) => a.value === b.value
        && a.valueHtml === b.valueHtml
        && a.eventId === b.eventId
        && a.aiDrafted === b.aiDrafted,
    )
    if (changed.size === 0) return
    this.pendingOverlay = next
    this.bumpCells(changed)
    this.rebuildDerivedIndexes()
    this.emit(changed)
  }

  setPendingProgressEventIds(next: readonly string[]): void {
    const unique = [...new Set(next)]
    if (unique.length === this.pendingProgressEventIds.length
      && unique.every((eventId, index) => eventId === this.pendingProgressEventIds[index])) return
    this.pendingProgressEventIds = unique
    this.fileVersion++
    this.emitAll()
  }

  clearOptimisticIfValue(cellId: string, value: string): boolean {
    const shadow = this.optimisticEdits.get(cellId)
    if (!shadow || shadow.value !== value) return false
    this.optimisticEdits.delete(cellId)
    this.bumpCells([cellId])
    this.rebuildDerivedIndexes()
    this.emit([cellId])
    return true
  }

  applyOptimisticTargetEdit(cellId: string, patch: PendingOverlay): void {
    const seq = ++this.writeSeq
    this.optimisticEdits.set(cellId, { ...patch, seq })
    this.freshnessFloors.set(cellId, seq)

    const existing = this.targetById.get(cellId)
    if (existing) {
      this.targetById.set(cellId, { ...existing, value: patch.value, valueHtml: patch.valueHtml ?? null, aiDrafted: patch.aiDrafted ?? false })
    } else {
      const source = this.sourceById.get(cellId)
      // No source row (mid-refetch/reset window): the shadow written above is
      // still live data that getCellView overlays, so fall through to the
      // bump + emit below — an early return here left the write invisible to
      // the subscribed row (stale until remount) while the footer moved on.
      if (!source) {
        this.rebuildDerivedIndexes()
        this.bumpCells([cellId])
        this.fileVersion++
        this.emit([cellId])
        return
      }
      this.targetById.set(cellId, {
        ...source,
        side: "target",
        value: patch.value,
        valueHtml: patch.valueHtml ?? null,
        eventId: "",
        sourceEventId: source.eventId,
        lastEditor: this.ctx.username,
        lastEditAt: Date.now(),
        validated: false,
        aiDrafted: patch.aiDrafted ?? false,
        wordCount: patch.value.trim() ? patch.value.trim().split(/\s+/).length : 0,
      })
      if (!this.targetOrder.includes(cellId)) this.targetOrder.push(cellId)
      if (!this.indexById.has(cellId)) {
        this.indexById.set(cellId, this.order.length)
        this.order.push(cellId)
        this.listVersion++
      }
    }

    this.rebuildDerivedIndexes()
    this.bumpCells([cellId])
    this.fileVersion++
    this.emit([cellId])
  }

  /** Bulk version of applyOptimisticTargetEdit. Stamps optimistic shadows for
   *  every cell in the batch and rebuilds derived indexes + emits ONCE at the
   *  end, instead of once per cell (O(N) not O(N²)). Used by the bulk-import
   *  path so imported cells don't flicker on flush-before-refetch. */
  applyOptimisticTargetEdits(patches: { cellId: string; value: string; valueHtml?: string }[]): void {
    if (patches.length === 0) return
    const changedIds = new Set<string>()
    let orderChanged = false
    for (const patch of patches) {
      const seq = ++this.writeSeq
      this.optimisticEdits.set(patch.cellId, { value: patch.value, valueHtml: patch.valueHtml, seq })
      this.freshnessFloors.set(patch.cellId, seq)

      const existing = this.targetById.get(patch.cellId)
      if (existing) {
        this.targetById.set(patch.cellId, { ...existing, value: patch.value, valueHtml: patch.valueHtml ?? null })
      } else {
        const source = this.sourceById.get(patch.cellId)
        if (!source) {
          changedIds.add(patch.cellId)
          continue
        }
        this.targetById.set(patch.cellId, {
          ...source,
          side: "target",
          value: patch.value,
          valueHtml: patch.valueHtml ?? null,
          eventId: "",
          sourceEventId: source.eventId,
          lastEditor: this.ctx.username,
          lastEditAt: Date.now(),
          validated: false,
          wordCount: patch.value.trim() ? patch.value.trim().split(/\s+/).length : 0,
        })
        if (!this.targetOrder.includes(patch.cellId)) this.targetOrder.push(patch.cellId)
        if (!this.indexById.has(patch.cellId)) {
          this.indexById.set(patch.cellId, this.order.length)
          this.order.push(patch.cellId)
          orderChanged = true
        }
      }
      changedIds.add(patch.cellId)
    }
    if (orderChanged) this.listVersion++
    this.rebuildDerivedIndexes()
    this.bumpCells(changedIds)
    this.fileVersion++
    this.emit(changedIds)
  }

  markCellFresh(cellId: string): void {
    this.freshnessFloors.set(cellId, ++this.writeSeq)
  }

  replaceRowsForCell(cellId: string, rows: CellRow[]): void {
    const bySide = new Map(rows.map((row) => [row.side, row]))
    const source = bySide.get("source")
    const target = bySide.get("target")
    if (source) {
      this.sourceById.set(cellId, source)
      if (!this.sourceOrder.includes(cellId)) this.sourceOrder.push(cellId)
    } else {
      this.sourceById.delete(cellId)
      this.sourceOrder = this.sourceOrder.filter((id) => id !== cellId)
    }
    if (target) {
      this.targetById.set(cellId, target)
      if (!this.targetOrder.includes(cellId)) this.targetOrder.push(cellId)
    } else {
      this.targetById.delete(cellId)
      this.targetOrder = this.targetOrder.filter((id) => id !== cellId)
    }

    const seen = new Set(this.sourceOrder)
    const nextOrder = [...this.sourceOrder]
    for (const id of this.targetOrder) if (!seen.has(id)) nextOrder.push(id)
    if (!sameStringArray(nextOrder, this.order)) this.listVersion++
    this.order = nextOrder
    this.indexById = new Map(this.order.map((id, index) => [id, index]))
    this.rebuildDerivedIndexes()
    this.bumpCells([cellId])
    this.fileVersion++
    this.emit([cellId])
  }

  getMemorySnapshot(extra?: Record<string, unknown>): Record<string, unknown> {
    let textBytes = 0
    let htmlBytes = 0
    for (const id of this.order) {
      const source = this.sourceById.get(id)
      const target = this.targetById.get(id)
      textBytes += roughBytes(source?.value) + roughBytes(target?.value)
      htmlBytes += roughBytes(source?.valueHtml) + roughBytes(target?.valueHtml)
    }
    return {
      projectId: this.ctx.projectId,
      fileId: this.ctx.fileId,
      cells: this.order.length,
      sourceRows: this.sourceById.size,
      targetRows: this.targetById.size,
      pendingEdits: this.pendingOverlay.size,
      optimisticEdits: this.optimisticEdits.size,
      navigationEntries: this.navIndex.length,
      footnoteCacheEntries: this.footnoteCache.size,
      textMB: +(textBytes / 1048576).toFixed(2),
      htmlMB: +(htmlBytes / 1048576).toFixed(2),
      maxServerSeq: this.maxServerSeq,
      ...extra,
    }
  }

  private applyContentOverlays(cell: CellData): void {
    const pending = this.pendingOverlay.get(cell.id)
    if (pending) {
      cell.translated = pending.value
      if (pending.valueHtml !== undefined) cell.translatedHtml = pending.valueHtml
      cell.status = deriveStatus(pending.value, false)
      cell.aiDrafted = pending.aiDrafted ?? false
      cell.hasPendingEdit = true
    }
    const optimistic = this.optimisticEdits.get(cell.id)
    if (optimistic) {
      cell.translated = optimistic.value
      // The optimistic value is authoritative for BOTH text and html. When an
      // edit carries no valueHtml (e.g. an AI completion commits plain `text`),
      // clear translatedHtml so the editor's html-first hydration falls back to
      // the fresh plain text instead of re-showing the stale prior html.
      cell.translatedHtml = optimistic.valueHtml
      cell.status = deriveStatus(optimistic.value, false)
      cell.aiDrafted = optimistic.aiDrafted ?? false
      cell.hasPendingEdit = true
    }
    if (pending || optimistic) {
      // The overlay changed `translated`/`status`; recompute validationStatus
      // from the overlaid text so the row's aria/ring can't keep reporting
      // "empty" (or a stale validator state) while showing the fresh value.
      cell.validationStatus = deriveValidationStatus(
        cell.status,
        cell.activeValidators,
        this.ctx.username,
        this.ctx.requiredValidations,
      )
    }
  }

  private ensureDerivedCache(): void {
    if (this.derivedCache.baseVersion === this.derivedVersion) return
    const summaries: CellSummary[] = []
    const textPairs: CellTextPair[] = []
    for (const id of this.order) {
      const summary = this.getCellSummary(id)
      if (!summary) continue
      summaries.push(summary)
      textPairs.push({
        cellId: id,
        fileId: summary.fileId,
        sourceText: summary.original,
        targetText: summary.translated,
        validated: summary.validated,
        index: summary.index,
      })
    }
    this.derivedCache = { baseVersion: this.derivedVersion, summaries, textPairs }
  }

  private rebuildDerivedIndexes(): void {
    this.derivedVersion++
    this.derivedCache = { baseVersion: -1, summaries: [], textPairs: [] }
    const nav = new Map<string, CellNavigationEntry>()
    const sectionById = new Map<string, string>()
    const footnoteOffsets = new Map<string, { source: number; target: number }>()
    const countsByScope = new Map<string, { source: number; target: number }>()
    const progressThreshold = Math.min(15, Math.max(1, this.ctx.requiredValidations))
    const emptyProgressCounts = (): ProgressCounts => ({
      totalCount: 0,
      filledCount: 0,
      validatedCount: 0,
      validationLevels: new Array(progressThreshold).fill(0),
    })
    const fileProgress = emptyProgressCounts()
    const sectionProgress = new Map<string, ProgressCounts>()

    const addProgress = (counts: ProgressCounts, filled: boolean, endorsements: number, validated: boolean): void => {
      counts.totalCount++
      if (filled) counts.filledCount++
      for (let level = 1; level <= progressThreshold; level++) {
        if (endorsements >= level) counts.validationLevels[level - 1]++
      }
      if (validated) counts.validatedCount++
    }

    for (let index = 0; index < this.order.length; index++) {
      const id = this.order[index]
      const source = this.sourceById.get(id)
      const target = this.targetById.get(id)
      const canonical = target?.canonicalRef ?? source?.canonicalRef ?? null
      const section = canonical ? sectionLabelFromCanonical(canonical) : ""
      if (section) {
        sectionById.set(id, section)
        let entry = nav.get(section)
        if (!entry) {
          entry = { label: section, firstCellId: id, firstIndex: index, translated: 0, validated: 0, total: 0 }
          nav.set(section, entry)
        }
        entry.total++
        if ((target?.value ?? "").trim()) entry.translated++
        if (target?.validated) entry.validated++
      }

      if (source) {
        const audit = this.ctx.auditStats.get(id)
        const endorsements = audit
          ? audit.activeValidators.length
          : Math.max(0, target?.endorsementCount ?? 0)
        const targetValue = this.optimisticEdits.get(id)?.value
          ?? this.pendingOverlay.get(id)?.value
          ?? target?.value
          ?? ''
        const hasAuthoritativeEndorsements = audit !== undefined || target?.endorsementCount !== undefined
        const validated = hasAuthoritativeEndorsements
          ? endorsements >= progressThreshold
          : Boolean(target?.validated)
        addProgress(fileProgress, targetValue.trim().length > 0, endorsements, validated)
        const progressSection = source.canonicalRef ? sectionLabelFromCanonical(source.canonicalRef) : ''
        if (progressSection) {
          let counts = sectionProgress.get(progressSection)
          if (!counts) {
            counts = emptyProgressCounts()
            sectionProgress.set(progressSection, counts)
          }
          addProgress(counts, targetValue.trim().length > 0, endorsements, validated)
        }
      }

      const scopeKey = footnoteScopeKey(this.ctx.fileId ?? "", canonical, section)
      const counts = countsByScope.get(scopeKey) ?? { source: 0, target: 0 }
      footnoteOffsets.set(id, { source: counts.source, target: counts.target })
      counts.source += countNumericFootnotes(source?.value ?? "")
      counts.target += countNumericFootnotes(target?.value ?? "")
      countsByScope.set(scopeKey, counts)
    }
    this.navIndex = Array.from(nav.values())
    this.fileProgressSnapshot = this.ctx.fileId && this.sourceOrder.length > 0
      ? {
          fileId: this.ctx.fileId,
          revision: this.maxServerSeq ?? 0,
          validationCount: progressThreshold,
          file: fileProgress,
          sections: [...sectionProgress].map(([key, counts]) => ({ key, ...counts })),
          source: 'projection',
        }
      : null
    this.sectionLabelById = sectionById
    this.footnoteOffsets = footnoteOffsets
  }

  private bumpCells(ids: Iterable<string>): void {
    for (const id of ids) {
      this.cellVersionById.set(id, ++this.versionCounter)
    }
  }

  private bumpAllCells(): void {
    this.bumpCells(this.order)
    this.fileVersion++
  }

  private emit(changedIds: Iterable<string>): void {
    for (const id of changedIds) {
      const listeners = this.cellListeners.get(id)
      if (listeners) for (const listener of Array.from(listeners)) listener()
    }
    this.emitList()
    this.emitAll()
  }

  private emitList(): void {
    for (const listener of Array.from(this.listListeners)) listener()
  }

  private emitAll(): void {
    for (const listener of Array.from(this.allListeners)) listener()
  }
}

export interface UseActiveCellStoreOptions {
  projectId: string | null
  fileId: string | null
  username?: string
  requiredValidations?: number
  auditStats?: ReadonlyMap<string, CellAuditStats>
  getToken?: (fileId: string) => Promise<string | null>
  enabled?: boolean
}

export interface UseActiveCellStoreResult {
  store: CellStore
  revalidate: () => void
  revalidateCell: (cellId: string) => void
  applyOptimisticTargetEdit: (cellId: string, patch: { value: string; valueHtml?: string; aiDrafted?: boolean }) => void
  /** Bulk version of applyOptimisticTargetEdit — see CellStore.applyOptimisticTargetEdits. */
  applyOptimisticTargetEdits: (patches: { cellId: string; value: string; valueHtml?: string }[]) => void
  isLoading: boolean
  isError: boolean
}

export function useActiveCellStore(opts: UseActiveCellStoreOptions): UseActiveCellStoreResult {
  const {
    projectId,
    fileId,
    username = "local",
    requiredValidations = 1,
    auditStats = EMPTY_STATS,
    getToken,
    enabled = true,
  } = opts
  const store = useMemo(() => new CellStore(), [])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== "undefined") (window as any).__cellStore = store
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const enabledRef = useRef(enabled)
  const tokenFetcherRef = useRef(getToken)
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)
  const tokenRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenAttemptsRef = useRef(0)
  const cellFetchInFlightRef = useRef<Set<string>>(new Set())

  projectRef.current = projectId
  fileRef.current = fileId
  enabledRef.current = enabled
  tokenFetcherRef.current = getToken

  useEffect(() => {
    store.setRuntime({ projectId, fileId, username, requiredValidations, auditStats })
  }, [auditStats, fileId, projectId, requiredValidations, store, username])

  const doFetch = useCallback(async (soft = false) => {
    const pid = projectRef.current
    const fid = fileRef.current
    const isEnabled = enabledRef.current
    const tokenFetcher = tokenFetcherRef.current
    if (!isEnabled || !pid || !fid) {
      store.reset(pid, fid)
      setIsLoading(false)
      setIsError(false)
      return
    }
    if (soft && inFlightRef.current) return
    const gen = ++generationRef.current
    inFlightRef.current = true
    let usedCache = false

    if (!soft) {
      store.reset(pid, fid)
      const cached = await readCellsCache(pid, fid)
      if (generationRef.current !== gen) return
      if (cached && cached.rows.length > 0) {
        store.replaceRows(cached.rows, { full: true, maxServerSeq: cached.maxServerSeq ?? null })
        setIsLoading(false)
        usedCache = true
      } else {
        store.setMaxServerSeq(null)
        setIsLoading(true)
      }
    }

    const effectiveSoft = soft || usedCache
    setIsError(false)
    try {
      const token = tokenFetcher ? await tokenFetcher(fid) : null
      if (!token) {
        if (generationRef.current !== gen) return
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

      const since = store.getMaxServerSeq()
      if (since !== null) {
        const deltaStartSeq = store.getWriteSeq()
        const result = await fetchCellsDelta(pid, fid, since, token)
        if (generationRef.current !== gen) return
        if (result.kind === "delta") {
          let nextWatermark = result.maxServerSeq
          if (result.changedCellIds.length > 0) {
            store.clearConfirmedShadows(result.cells, deltaStartSeq)
            const merged = mergeCellsDelta(store.toRows(), result.changedCellIds, result.cells)
            const { rows: kept, discardedCellIds } = store.mergeProtectedRows(merged, deltaStartSeq)
            store.replaceRows(kept, { changedCellIds: result.changedCellIds, maxServerSeq: discardedCellIds.size > 0 ? since : nextWatermark })
            if (discardedCellIds.size > 0) nextWatermark = since
            void writeCellsCache(pid, fid, store.toRows(), nextWatermark)
          } else if (result.maxServerSeq !== since) {
            store.setMaxServerSeq(result.maxServerSeq)
            void writeCellsCache(pid, fid, store.toRows(), result.maxServerSeq)
          }
          setIsLoading(false)
          return
        }
      }

      const buffer: CellRow[] = []
      const hardRows: CellRow[] = []
      let paintedFirstPage = false
      const pushRows = (rows: CellRow[], rebuild: boolean): boolean | void => {
        if (generationRef.current !== gen) return false
        if (rows.length === 0) return
        if (effectiveSoft) {
          for (const row of rows) buffer.push(row)
          return
        }
        for (const row of rows) hardRows.push(row)
        if (rebuild && !paintedFirstPage) {
          paintedFirstPage = true
          store.replaceRows(hardRows, { full: true })
        }
      }

      const startSeq = store.getWriteSeq()
      let streamMaxSeq: number | null = null
      let streamTorn = false
      let cursorSeen = false
      const trackStreamMeta = () => {
        let sideFirst: number | null = null
        let sideSeen = false
        return (meta: { maxServerSeq?: number | null }) => {
          const value = typeof meta.maxServerSeq === "number" ? meta.maxServerSeq : null
          if (!cursorSeen) {
            cursorSeen = true
            streamMaxSeq = value
          }
          if (!sideSeen) {
            sideSeen = true
            sideFirst = value
          } else if (value !== sideFirst) {
            streamTorn = true
          }
        }
      }

      await streamFileCells(pid, fid, token, (rows) => pushRows(rows, false), "target", trackStreamMeta())
      if (generationRef.current !== gen) return
      await streamFileCells(pid, fid, token, (rows) => pushRows(rows, true), "source", trackStreamMeta())
      if (generationRef.current !== gen) return

      let discardedProtected = false
      if (effectiveSoft) {
        store.clearConfirmedShadows(buffer, startSeq)
        const { rows: kept, discardedCellIds } = store.mergeProtectedRows(buffer, startSeq)
        discardedProtected = discardedCellIds.size > 0
        store.replaceRows(kept, { full: true })
      } else {
        store.replaceRows(hardRows, { full: true })
      }

      const watermark = streamTorn || discardedProtected ? null : streamMaxSeq
      store.setMaxServerSeq(watermark)
      void writeCellsCache(pid, fid, store.toRows(), watermark ?? undefined)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useActiveCellStore] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    } finally {
      if (generationRef.current === gen) inFlightRef.current = false
    }
  }, [store])

  useEffect(() => {
    if (tokenRetryRef.current) {
      clearTimeout(tokenRetryRef.current)
      tokenRetryRef.current = null
    }
    store.reset(projectId, fileId)
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, enabled])

  useEffect(() => {
    if (!enabled || !fileId) {
      store.setPendingOverlay(new Map())
      store.setPendingProgressEventIds([])
      return
    }
    let cancelled = false
    async function refresh() {
      const all = await peekOutboxBatch(2000)
      if (cancelled) return
      const fid = fileRef.current
      const next = new Map<string, PendingOverlay>()
      const pendingProgressEventIds: string[] = []
      for (const record of all) {
        if (fid && record.event.fileId !== fid) continue
        const kind = record.event.kind
        const failed = (record.status ?? "pending") === "failed"
        if (!failed && (
          kind.startsWith("source.cell.") ||
          kind.startsWith("target.cell.") ||
          kind === "cell.validate" ||
          kind === "cell.unvalidate"
        )) {
          pendingProgressEventIds.push(record.event.id)
        }
        if (kind !== "target.cell.commit" && kind !== "target.cell.create") continue
        const cellId = record.event.cellId
        if (!cellId) continue
        const payload = record.event.payload as { value?: string; valueHtml?: string; ai_suggestion?: true }
        if (failed) {
          if (typeof payload.value === "string") store.clearOptimisticIfValue(cellId, payload.value)
          continue
        }
        if (typeof payload.value !== "string") continue
        next.set(cellId, {
          value: payload.value,
          valueHtml: payload.valueHtml,
          eventId: record.event.id,
          aiDrafted: payload.ai_suggestion === true,
        })
      }
      store.setPendingOverlay(next)
      store.setPendingProgressEventIds(pendingProgressEventIds)
    }
    void refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [enabled, fileId, store])

  useEffect(() => () => {
    if (tokenRetryRef.current) clearTimeout(tokenRetryRef.current)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    function onFocus() { void doFetch(true) }
    function onVis() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void doFetch(true)
    }
    window.addEventListener("focus", onFocus)
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis)
    return () => {
      window.removeEventListener("focus", onFocus)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis)
    }
  }, [doFetch])

  const revalidate = useCallback(() => {
    void doFetch(true)
  }, [doFetch])

  const refreshCellsCacheFromStore = useCallback((maxServerSeq?: number) => {
    const pid = projectRef.current
    const fid = fileRef.current
    if (!pid || !fid) return
    void writeCellsCache(pid, fid, store.toRows(), maxServerSeq ?? store.getMaxServerSeq() ?? undefined)
  }, [store])

  const revalidateCellRef = useRef<(cellId: string) => void>(() => {})
  const revalidateCell = useCallback((cellId: string) => {
    const pid = projectRef.current
    const fid = fileRef.current
    const isEnabled = enabledRef.current
    const tokenFetcher = tokenFetcherRef.current
    if (!isEnabled || !pid || !fid || !tokenFetcher) return
    if (cellFetchInFlightRef.current.has(cellId)) return
    cellFetchInFlightRef.current.add(cellId)
    const gen = generationRef.current
    let exhaustedByDiscard = false
    void (async () => {
      try {
        const token = await tokenFetcher(fid)
        if (!token) return
        for (let attempt = 0; attempt < 2; attempt++) {
          if (generationRef.current !== gen) return
          const startSeq = store.getWriteSeq()
          const rows = await fetchCellsByIds(pid, fid, [cellId], token)
          if (generationRef.current !== gen) return
          if (projectRef.current !== pid || fileRef.current !== fid) return
          const floor = store.getFreshnessFloor(cellId)
          if (floor !== undefined && floor > startSeq) {
            exhaustedByDiscard = true
            continue
          }
          exhaustedByDiscard = false
          store.clearConfirmedShadows(rows, startSeq)
          store.markCellFresh(cellId)
          store.replaceRowsForCell(cellId, rows)
          refreshCellsCacheFromStore()
          return
        }
      } catch {
        exhaustedByDiscard = false
        if (generationRef.current === gen) void doFetch(true)
      } finally {
        cellFetchInFlightRef.current.delete(cellId)
        if (
          exhaustedByDiscard &&
          generationRef.current === gen &&
          projectRef.current === pid &&
          fileRef.current === fid
        ) {
          revalidateCellRef.current(cellId)
        }
      }
    })()
  }, [doFetch, refreshCellsCacheFromStore, store])
  revalidateCellRef.current = revalidateCell

  const applyOptimisticTargetEdit = useCallback((cellId: string, patch: { value: string; valueHtml?: string; aiDrafted?: boolean }) => {
    store.applyOptimisticTargetEdit(cellId, patch)
  }, [store])

  const applyOptimisticTargetEdits = useCallback((patches: { cellId: string; value: string; valueHtml?: string }[]) => {
    store.applyOptimisticTargetEdits(patches)
  }, [store])

  useEffect(() => {
    if (typeof window === "undefined") return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__aquillaMemorySnapshot = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const memory = (performance as any).memory
      const root = document.querySelector("[data-aquilla-editor-root]") ?? document
      const rowCount = root.querySelectorAll("[data-cell-id][data-index]").length
      const prosemirrorCount = root.querySelectorAll(".ProseMirror").length
      const expandedCellCount = root.querySelectorAll('[data-cell-expanded="true"]').length
      const mountedDetailTabs = Array.from(root.querySelectorAll<HTMLElement>("[data-cell-detail-tab]"))
        .map((el) => el.dataset.cellDetailTab)
        .filter(Boolean)
      const nodeCount = document.getElementsByTagName("*").length
      const rowRenderMap = (window as typeof window & { __perfRowRenders?: Map<string, number> }).__perfRowRenders
      const diagnostics = window as typeof window & {
        __aquillaAlignmentModelBuilt?: boolean
        __aquillaBtGenerationInFlight?: number
      }
      return store.getMemorySnapshot({
        usedJSHeapMB: memory?.usedJSHeapSize ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        totalJSHeapMB: memory?.totalJSHeapSize ? +(memory.totalJSHeapSize / 1048576).toFixed(1) : null,
        domNodes: nodeCount,
        mountedRows: rowCount,
        prosemirrorEditors: prosemirrorCount,
        expandedCellCount,
        mountedDetailTab: mountedDetailTabs[0] ?? null,
        mountedDetailTabs,
        alignmentModelBuilt: Boolean(diagnostics.__aquillaAlignmentModelBuilt),
        btGenerationInFlight: diagnostics.__aquillaBtGenerationInFlight ?? 0,
        rowRenderCounters: rowRenderMap?.size ?? null,
      })
    }
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__aquillaMemorySnapshot) delete (window as any).__aquillaMemorySnapshot
    }
  }, [store])

  return { store, revalidate, revalidateCell, applyOptimisticTargetEdit, applyOptimisticTargetEdits, isLoading, isError }
}

/**
 * Anchor a store read to a version counter so the React Compiler keys the
 * surrounding memo on the version. The compiler infers memoization deps from
 * the values REFERENCED in the computation and DISCARDS manual dep arrays —
 * `useMemo(() => store.read(), [store, version])` compiles to a cache guarded
 * only by `store`, so the read is frozen at its mount-time value and the row
 * stays stale forever while the store (and footer) move on. Routing every
 * version-keyed read through this function makes the version an operand the
 * compiler must track.
 */
export function readAtVersion<T>(version: number, read: () => T): T {
  if (Number.isNaN(version)) throw new Error("unreachable: version counters are integers")
  return read()
}

export function useCellIds(store: CellStore, orderedBy?: OrderedBy, mediaLayer = false): readonly string[] {
  const version = useSyncExternalStore(store.subscribeList, store.getListVersion, () => 0)
  return useMemo(
    () => readAtVersion(version, () => store.getCellIdsForLens(orderedBy, mediaLayer)),
    [mediaLayer, orderedBy, store, version],
  )
}

export function useCellView(store: CellStore, cellId: string): CellViewModel | null {
  const subscribe = useCallback((listener: () => void) => store.subscribeCell(cellId, listener), [store, cellId])
  const getSnapshot = useCallback(() => store.getCellVersion(cellId), [store, cellId])
  const version = useSyncExternalStore(subscribe, getSnapshot, () => 0)
  return useMemo(() => readAtVersion(version, () => store.getCellView(cellId)), [cellId, store, version])
}

export function useCellStoreVersion(store: CellStore): number {
  return useSyncExternalStore(store.subscribeAll, store.getAllVersion, () => 0)
}

export function useCellStoreViews(store: CellStore): CellViewModel[] {
  const version = useCellStoreVersion(store)
  return useMemo(() => readAtVersion(version, () => store.getAllCellViews()), [store, version])
}

function deriveStatus(translated: string, validated: boolean): CellData["status"] {
  if (!translated || !translated.trim()) return "empty"
  return validated ? "validated" : "unvalidated"
}

function deriveValidationStatus(
  status: CellData["status"],
  activeValidators: string[],
  username: string,
  requiredValidations: number,
): CellData["validationStatus"] {
  if (status === "empty") return "empty"
  if (activeValidators.length === 0) return status === "validated" ? "full-others" : "none"
  if (activeValidators.length >= requiredValidations) {
    return activeValidators.includes(username) ? "full-self" : "full-others"
  }
  return activeValidators.includes(username) ? "self" : "others"
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function waiversEqual(a: readonly RuleWaiver[], b: readonly RuleWaiver[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].ruleId !== b[i].ruleId || a[i].reason !== b[i].reason
      || a[i].waivedAt !== b[i].waivedAt || a[i].waivedBy !== b[i].waivedBy) return false
  }
  return true
}

function auditStatsEqual(a: CellAuditStats | undefined, b: CellAuditStats | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.editCount === b.editCount &&
    a.contentHash === b.contentHash &&
    a.lastEditAt === b.lastEditAt &&
    a.lastEditEventId === b.lastEditEventId &&
    sameStringArray(a.activeValidators, b.activeValidators) &&
    waiversEqual(a.waivers, b.waivers)
  )
}

/**
 * Cell ids whose audit-stats entry actually changed between two stats maps.
 * Targeted single-cell refetches produce a `new Map(prev)` that shares entry
 * references for every untouched cell, so the `prevStats === nextStats` fast
 * path skips them in O(1) and only the genuinely-changed cell is value-compared
 * — keeping the per-cell emit set small even on Bible-sized files.
 */
function diffChangedAuditCellIds(
  prev: ReadonlyMap<string, CellAuditStats>,
  next: ReadonlyMap<string, CellAuditStats>,
): Set<string> {
  const changed = new Set<string>()
  if (prev === next) return changed
  for (const [id, nextStats] of next) {
    const prevStats = prev.get(id)
    if (prevStats === nextStats) continue
    if (!auditStatsEqual(prevStats, nextStats)) changed.add(id)
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) changed.add(id)
  }
  return changed
}

function symmetricChangedKeys<T>(
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
  equal: (a: T, b: T) => boolean,
): Set<string> {
  const changed = new Set<string>()
  for (const [key, av] of a) {
    const bv = b.get(key)
    if (bv === undefined || !equal(av, bv)) changed.add(key)
  }
  for (const key of b.keys()) if (!a.has(key)) changed.add(key)
  return changed
}

function sectionLabelFromCanonical(ref: string): string {
  const colonIdx = ref.indexOf(":")
  return (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
}

function footnoteScopeKey(fileId: string, canonical: string | null, section: string): string {
  if (canonical) {
    const parsed = parseFootnoteChapterScope(canonical)
    if (parsed) return `${fileId}:${parsed}`
  }
  return `${fileId}:${section || "__file__"}`
}

function parseFootnoteChapterScope(value: string): string | null {
  const canonical = value.match(/\b([1-3]?\s?[A-Z][A-Z0-9]{1,4})\s+(\d+):\d+/i)
  if (canonical) return `${canonical[1].replace(/\s+/g, "").toUpperCase()}:${canonical[2]}`
  const chapterOnly = value.match(/\b(\d+):\d+\b/)
  if (chapterOnly) return `chapter:${chapterOnly[1]}`
  return null
}

function countNumericFootnotes(text: string): number {
  return extractUsfmFootnotes(text).filter((footnote) => {
    const caller = footnote.caller.trim()
    return caller === "" || caller === "+" || caller === "-" || /^\d+$/.test(caller)
  }).length
}

function roughBytes(value: string | null | undefined): number {
  return value ? value.length * 2 : 0
}
