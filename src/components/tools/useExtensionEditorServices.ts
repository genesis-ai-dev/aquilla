/**
 * Smart Extensions, apiRev 3: assemble the workspace's editor pipeline into
 * the services an `editor` extension mounted for the open file reaches
 * through the bridge (see src/lib/tools/editor-services.ts). Pure assembly —
 * every handler is the one the built-in editor already uses, so the two
 * editors cannot drift apart in behaviour, only in rendering.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import type { CellStore } from "@/hooks/useActiveCellStore"
import type { BacktranslationRecord } from "@/lib/completion/bt-record"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import type { ProjectPresenceStore, TargetPresenceSelection } from "@/lib/sync/presence-store"
import { useSelectedIds } from "@/lib/audio/selection"
import type { ScoredPair } from "@/lib/search/dual-index"
import { createScopedRibbonCache } from "@/lib/health/scoped-ribbon"
import { healthRibbonColor, healthRibbonOpacity, type HealthRibbonPoint } from "@/lib/health/health-ribbon"
import { effectiveSourceText } from "@/lib/cell-text"
import { readAtVersion } from "@/hooks/useActiveCellStore"
import { createEditorStructureCache } from "@/lib/editor-structure-cache"
import { usePericopeSuggestions } from "@/hooks/usePericopeSuggestions"
import { resolvePericopeResumeBy } from "@/lib/pericope/resume"
import { compareAddresses, parseRef } from "@/lib/pericope/sections"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import type { ToolCellStructure } from "@/lib/tools/editor-services"
import { formatInfractionReason } from "@/lib/rules/format-infraction"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolEditorServices } from "@/lib/tools/editor-services"
import { suggestFor, recordSuggestionFeedback, setSuggestionMemory } from "@/lib/tools/suggestions"
import type { ToolOrigin } from "../../../shared/tools/manifest"
import type {
  ToolBacktranslation,
  ToolCellIssue,
  ToolCellSignals,
  ToolEditorConfig,
  ToolLens,
  ToolPresencePeer,
  ToolRibbon,
  ToolPericope,
} from "../../../shared/tools/editor-api"

export interface ExtensionEditorServicesArgs {
  enabled: boolean
  fileId: string | null
  store: CellStore
  storeLoading: boolean
  config: Omit<ToolEditorConfig, "fileId"> | null
  staleCellIds?: ReadonlySet<string>
  upstreamStaleCellIds?: ReadonlySet<string>
  assignmentsByCellId?: ReadonlyMap<string, { username: string; scopeLabel: string }>
  repetitionCounts?: ReadonlyMap<string, number>
  infractions?: Map<string, RuleInfraction[]>
  rules?: TranslationRule[]
  healthMap?: Map<string, number>
  /** Health calculations on (the ribbon), and its inputs. */
  healthEnabled: boolean
  examples: Map<string, ScoredPair[]>
  /** Bumps on every store change (drives the ribbon's neighbour smoothing). */
  storeVersion: number
  /** The voice a line speaks in (cast assignment, else project default). */
  voiceFor: (cellId: string) => { name: string; explicit: boolean } | null
  completing: Map<string, string>
  previews: Map<string, string>
  errors: Map<string, string>
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  backtranslationCache?: ReadonlyMap<string, BacktranslationRecord>
  cellsWithRemoteChange?: ReadonlySet<string>
  presenceStore: ProjectPresenceStore
  concepts: readonly Concept[]
  termMatching?: TermMatchingSettings
  commitTarget: (cellId: string, snapshot: { value: string; valueHtml: string }, origin?: ToolOrigin) => Promise<{ autoValidated: boolean }>
  setValidation: (cellId: string, validated: boolean, origin?: ToolOrigin) => Promise<boolean>
  onCellValidated: (cellId: string) => Promise<void> | void
  completeSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<boolean>
  completeBatch: (cells: CellData[]) => void
  completeParagraph: (cellId: string) => void
  openAiSetup: () => void
  runBacktranslation: (cell: CellData, source: "read-back" | "refresh" | "regenerate") => Promise<void> | void
  saveBacktranslation: (cell: CellData, text: string, polished: boolean) => void
  openHistory: (cellId: string) => void
  openAttachment: (cellId: string, attachmentId: string) => void
  openRule: (ruleId: string) => void
  openTerm: (conceptId: string) => void
  openRecording: (cellId: string) => void
  generateAudio: (cellId: string) => Promise<boolean>
  targetPresenceSelection: (cellId: string, selection: TargetPresenceSelection | null) => void
  viewCell: (cellId: string | null) => void
  visibleCells: (cellIds: string[]) => void
  setSelection: (ids: string[]) => void
  setLane: (tag: string) => void
  setLens: (lens: ToolLens) => void
  openSettings: (section: "target-language" | "lanes" | "terminology") => void
}

const EMPTY_IDS: readonly string[] = []
const EMPTY_EXAMPLES: ScoredPair[] = []

/** The ribbon's line as HealthRibbon.tsx paints it. */
export function ribbonToTool(point: HealthRibbonPoint): ToolRibbon {
  const score = point.smoothedScore
  const opacity = healthRibbonOpacity(point)
  const background = score === undefined
    ? `repeating-linear-gradient(to bottom, rgb(148 163 184 / ${opacity}) 0 4px, transparent 4px 7px)`
    : `linear-gradient(to bottom, ${healthRibbonColor(point.topScore ?? score, point.topOpacity ?? opacity)} 0%, ${healthRibbonColor(score, opacity)} 42%, ${healthRibbonColor(score, opacity)} 58%, ${healthRibbonColor(point.bottomScore ?? score, point.bottomOpacity ?? opacity)} 100%)`
  const raw = point.rawScore === undefined ? null : Math.round(point.rawScore)
  const label = point.stage === "validated"
    ? "100% assurance · human validated"
    : point.stage === "automatic"
      ? raw === null ? "Automatic health awaiting evidence" : `Automatic health ${raw}%`
      : raw === null ? "Pre-translation source evidence unavailable" : `Pre-translation source evidence ${raw}%`
  return { stage: point.stage, background, score: score === undefined ? null : Math.round(score), label }
}

function severityOf(rule: TranslationRule | undefined): ToolCellIssue["severity"] {
  return rule?.severity === "major" ? "error" : "warning"
}

/** Collaborators with their colour, cell and live draft (presence store). */
function usePeers(store: ProjectPresenceStore, fileId: string | null): ToolPresencePeer[] {
  const peers = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribeRoster(cb), [store]),
    useCallback(() => store.getPeers(), [store]),
    () => store.getPeers(),
  )
  return useMemo(
    () =>
      peers
        .filter((p) => !fileId || !p.currentFileId || p.currentFileId === fileId)
        .map((p) => ({
          username: p.username,
          color: p.color,
          // Focus keys may be lane-qualified ("cellId@lane:x"): the cell is the head.
          cellId: (p.focusedCell ?? p.viewingCell ?? "").split("@lane:")[0] || null,
          editing: p.isEditing,
          draftText: p.selection?.draftText ?? null,
          caret: p.selection ? { anchor: p.selection.anchor, head: p.selection.head } : null,
        })),
    [peers, fileId],
  )
}

export function useExtensionEditorServices(args: ExtensionEditorServicesArgs): ToolEditorServices | undefined {
  const t = useT()
  const selected = useSelectedIds()
  const peers = usePeers(args.presenceStore, args.fileId)
  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })
  // Cells whose own commit auto-validated and so owe repetition propagation
  // once the translator leaves the cell (AQU-1484's settled-edit rule).
  const owedRef = useRef(new Set<string>())

  // Translation memory for the ghost-text provider: the open file's pairs.
  const memoryStore = args.enabled ? args.store : null
  useEffect(() => {
    if (!memoryStore) return
    return setSuggestionMemory(() =>
      memoryStore.getTextPairs().map((p) => ({ cellId: p.cellId, source: p.sourceText, target: p.targetText })),
    )
  }, [memoryStore])

  // The health ribbon, smoothed over neighbours exactly as EditorTable does.
  const ribbonCache = useMemo(() => createScopedRibbonCache(), [args.store])
  const ribbonFor = useMemo(() => {
    if (!args.enabled || !args.healthEnabled) return () => null
    const store = args.store
    const healthMap = args.healthMap
    const examples = args.examples
    const reader = readAtVersion(args.storeVersion, () => {
      const ids = store.getCellIds()
      return ribbonCache.read<CellData>(ids, new Map(ids.map((id, i) => [id, i])), {
        getCellVersion: store.getCellVersion,
        getCell: (id) => store.getCellView(id),
        sourceText: effectiveSourceText,
        health: (id) => healthMap?.get(id),
        examples: (id) => examples.get(id) ?? EMPTY_EXAMPLES,
      })
    })
    return (cellId: string) => {
      const point = reader.get(cellId)
      return point ? ribbonToTool(point) : null
    }
  }, [args.enabled, args.healthEnabled, args.store, args.storeVersion, args.healthMap, args.examples, ribbonCache])

  // Gutter numbering + paragraph groups, as EditorTable derives them.
  const structureCache = useMemo(() => createEditorStructureCache(), [args.store])
  const structureFor = useMemo(() => {
    const store = args.store
    const ids = readAtVersion(args.storeVersion, () => store.getCellIds())
    const { sequentialNumberByCellId, paragraphGroupInfoByCellId } = structureCache.read(ids, store)
    const index = new Map(ids.map((id, i) => [id, i]))
    const scriptureNumbering = store.getNavigationIndex().every((e) =>
      e.kind === "chapter" || e.kind === "chapter-range" || e.kind === "preface")
    return (cellId: string): ToolCellStructure => {
      const rowIndex = index.get(cellId) ?? 0
      const group = paragraphGroupInfoByCellId.get(cellId)
      return {
        rowIndex,
        contentNumber: sequentialNumberByCellId.get(cellId) ?? rowIndex + 1,
        scriptureNumbering,
        paragraph: group && group.memberIds[0] === cellId ? { size: group.size, draftable: group.draftableCount } : null,
      }
    }
  }, [args.store, args.storeVersion, structureCache])

  // Suggested passages (AQU-515), exactly as EditorTable resolves them.
  const pericopeResume = useMemo(() => {
    if (!args.enabled) return null
    const store = args.store
    return readAtVersion(args.storeVersion, () => resolvePericopeResumeBy(store.getCellIds(), (cellId) => {
      const view = store.getCellView(cellId)
      return view ? { canonicalRef: view.group, translated: view.translated.trim().length > 0 } : null
    }))
  }, [args.enabled, args.store, args.storeVersion])
  const pericopeSuggestions = usePericopeSuggestions(pericopeResume)
  const pericopes = useMemo<ToolPericope[]>(() => {
    const store = args.store
    const ids = store.getCellIds()
    const out: ToolPericope[] = []
    for (const s of pericopeSuggestions) {
      const cellId = ids.find((id) => {
        const parsed = parseRef(store.getCellView(id)?.group ?? "")
        return Boolean(parsed && parsed.book === s.book && compareAddresses(parsed.address, s.start) >= 0 && compareAddresses(parsed.address, s.end) <= 0)
      })
      if (!cellId) continue
      out.push({
        key: s.key,
        label: t("editor.pericope.range", { book: getBookName(s.book) ?? s.book, start: `${s.start.chapter}:${s.start.verse}`, end: `${s.end.chapter}:${s.end.verse}` }),
        detail: s.continuation ? t("editor.pericope.continues") : t("editor.pericope.agreement", { count: s.translations }),
        cellId,
      })
    }
    return out
  }, [pericopeSuggestions, args.store, t])

  const ruleById = useMemo(() => new Map((args.rules ?? []).map((r) => [r.id, r])), [args.rules])

  const signals = useMemo<ToolCellSignals>(() => {
    const issues: ToolCellSignals["issues"] = {}
    for (const [cellId, list] of args.infractions ?? []) {
      if (list.length === 0) continue
      const waived = new Set((args.store.getCellView(cellId)?.waivers ?? []).map((w) => w.ruleId))
      issues[cellId] = list.map((inf) => ({
        ruleId: inf.ruleId,
        ruleName: ruleById.get(inf.ruleId)?.name ?? inf.ruleId,
        message: formatInfractionReason(inf, t),
        severity: severityOf(ruleById.get(inf.ruleId)),
        spans: inf.spans.map((s) => ({ side: s.side, start: s.start, end: s.end })),
        waived: waived.has(inf.ruleId),
      }))
    }
    const health: ToolCellSignals["health"] = {}
    for (const [cellId, point] of args.healthMap ?? []) {
      const list = issues[cellId] ?? []
      health[cellId] = { point, major: list.some((i) => i.severity === "error" && !i.waived), issue: list.some((i) => !i.waived) }
    }
    const ai: ToolCellSignals["ai"] = {}
    for (const [cellId, phase] of args.completing) {
      ai[cellId] = { phase: phase === "searching" ? "searching" : "generating", preview: args.previews.get(cellId) ?? null, error: null }
    }
    for (const [cellId, error] of args.errors) ai[cellId] = { phase: ai[cellId]?.phase ?? null, preview: ai[cellId]?.preview ?? null, error }
    return {
      stale: [...(args.staleCellIds ?? [])],
      upstreamStale: [...(args.upstreamStaleCellIds ?? [])],
      assignments: Object.fromEntries(args.assignmentsByCellId ?? []),
      repetition: Object.fromEntries([...(args.repetitionCounts ?? [])].filter(([, n]) => n > 1)),
      issues,
      health,
      ai,
      backtranslating: [...(args.backtranslating ?? [])],
      remoteChanged: [...(args.cellsWithRemoteChange ?? [])],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store is read for waivers only; signals follow the maps
  }, [args.infractions, args.healthMap, args.completing, args.previews, args.errors, args.staleCellIds, args.upstreamStaleCellIds,
    args.assignmentsByCellId, args.repetitionCounts, args.backtranslating, args.cellsWithRemoteChange, ruleById, t])

  const backtranslations = useMemo(() => {
    const out = new Map<string, ToolBacktranslation>()
    for (const [cellId, rec] of args.backtranslationCache ?? []) {
      const cell = args.store.getCellView(cellId)
      out.set(cellId, {
        cellId,
        text: rec.btText,
        stale: Boolean(cell && rec.forText && rec.forText !== cell.translated),
        polished: rec.polished,
        author: rec.author ?? null,
        error: args.backtranslationErrors?.get(cellId) ?? null,
      })
    }
    for (const [cellId, error] of args.backtranslationErrors ?? []) {
      if (!out.has(cellId)) out.set(cellId, { cellId, text: "", stale: false, polished: false, author: null, error })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- staleness is re-derived when the cache or errors change
  }, [args.backtranslationCache, args.backtranslationErrors])

  const selection = useMemo(() => (selected.size === 0 ? EMPTY_IDS : [...selected]), [selected])
  const fileId = args.fileId
  const config = useMemo<ToolEditorConfig | null>(
    () => (args.config && fileId ? { ...args.config, fileId } : null),
    [args.config, fileId],
  )

  const cellOf = useCallback((cellId: string): CellData => {
    const cell = argsRef.current.store.getCellView(cellId)
    if (!cell) throw new Error("This cell is no longer available in the open file.")
    return cell
  }, [])

  const actions = useMemo(() => ({
    commitTarget: async (cellId: string, snapshot: { value: string; valueHtml: string }, origin: ToolOrigin) => {
      const res = await argsRef.current.commitTarget(cellId, snapshot, origin)
      if (res.autoValidated) owedRef.current.add(cellId)
      return res
    },
    setValidation: async (cellId: string, validated: boolean, origin: ToolOrigin) => {
      const ok = await argsRef.current.setValidation(cellId, validated, origin)
      if (ok && validated) {
        owedRef.current.delete(cellId)
        void argsRef.current.onCellValidated(cellId)
      }
      return ok
    },
    settle: (cellId: string) => {
      if (!owedRef.current.delete(cellId)) return
      void argsRef.current.onCellValidated(cellId)
    },
    draft: async (cellIds: string[], opts: { regenerate?: boolean }) => {
      const cells = cellIds.map(cellOf)
      if (cells.length === 1) return (await argsRef.current.completeSingle(cells[0], opts)) !== false
      argsRef.current.completeBatch(cells)
      return true
    },
    openAiSetup: () => argsRef.current.openAiSetup(),
    draftParagraph: async (cellId: string) => {
      cellOf(cellId)
      argsRef.current.completeParagraph(cellId)
      return true
    },
    backtranslate: async (cellId: string) => {
      const cell = cellOf(cellId)
      const hasReading = argsRef.current.backtranslationCache?.has(cellId)
      await argsRef.current.runBacktranslation(cell, hasReading ? "regenerate" : "read-back")
      return true
    },
    saveBacktranslation: (cellId: string, text: string) => {
      argsRef.current.saveBacktranslation(cellOf(cellId), text, false)
      return true
    },
    openHistory: (cellId: string) => argsRef.current.openHistory(cellId),
    openAttachments: (cellId: string) => {
      const first = Object.keys(argsRef.current.store.getCellView(cellId)?.attachments ?? {})[0] ?? ""
      argsRef.current.openAttachment(cellId, first)
    },
    openRule: (ruleId: string) => argsRef.current.openRule(ruleId),
    openTerm: (conceptId: string) => argsRef.current.openTerm(conceptId),
    openRecorder: (cellId: string) => argsRef.current.openRecording(cellId),
    generateAudio: (cellId: string) => argsRef.current.generateAudio(cellId),
    typing: (cellId: string, sel: { anchor: number; head: number; draftText: string } | null) =>
      argsRef.current.targetPresenceSelection(cellId, sel ? { side: "target", anchor: sel.anchor, head: sel.head, draftText: sel.draftText } : null),
    viewing: (cellId: string | null) => argsRef.current.viewCell(cellId),
    visible: (cellIds: string[]) => argsRef.current.visibleCells(cellIds),
    setSelection: (ids: string[]) => argsRef.current.setSelection(ids),
    setLane: (tag: string) => argsRef.current.setLane(tag),
    setLens: (lens: ToolLens) => argsRef.current.setLens(lens),
    openSettings: (section: "target-language" | "lanes" | "terminology") => argsRef.current.openSettings(section),
    suggest: (cellId: string, prefix: string) => {
      const cell = argsRef.current.store.getCellView(cellId)
      return cell ? suggestFor({ cellId, fileId: cell.fileId, source: cell.original, prefix }) : Promise.resolve([])
    },
    suggestionFeedback: (cellId: string, suggestionId: string, accepted: boolean) => recordSuggestionFeedback(cellId, suggestionId, accepted),
  }), [cellOf])

  return useMemo(() => {
    if (!args.enabled || !config) return undefined
    return {
      store: args.store,
      storeLoading: args.storeLoading,
      config,
      signals,
      peers,
      backtranslations,
      selection,
      pericopes,
      concepts: args.concepts,
      termMatching: args.termMatching,
      ribbonFor,
      structureFor,
      voiceFor: args.voiceFor,
      ...actions,
    }
  }, [args.voiceFor, pericopes, structureFor, args.enabled, args.store, args.storeLoading, args.concepts, args.termMatching, config, signals, peers, backtranslations, selection, actions, ribbonFor])
}
