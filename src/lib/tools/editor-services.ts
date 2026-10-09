/**
 * Smart Extensions, apiRev 3: what the WORKSPACE lends an `editor` extension
 * mounted for its open file. Nothing here is privileged per extension: every
 * editor mount gets the same services, and every call still goes through the
 * bridge's scope gate. The point is that an editor extension and the built-in
 * editor drive ONE pipeline — the same cell store (one read of the file, not
 * two), the same commit path (optimistic store edit, auto-validate own edit,
 * repetition propagation, outbox flush), the same AI drafting, back-
 * translation, rules/health, history/comments/attachments drawers, recorder
 * and bulk selection bar. Writes stay attributed to the extension
 * (`tool_origin`).
 */

import type { CellData } from "@/hooks/useCells"
import type { CellStore } from "@/hooks/useActiveCellStore"
import { sanitizeSourceDisplayHtml } from "@/lib/richtext/editor-content"
import { findConceptMatches } from "@/lib/terminology/match"
import { cellNumberLabel, importDisplayLabel, verseRangeLabel } from "@/lib/scripture-reference"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import type { ToolOrigin } from "../../../shared/tools/manifest"
import type {
  ToolBacktranslation,
  ToolCellSignals,
  ToolEditorConfig,
  ToolLens,
  ToolPresencePeer,
  ToolSection,
  ToolSuggestion,
  ToolTermMatch,
  ToolRibbon,
  ToolPericope,
} from "../../../shared/tools/editor-api"
import type { ToolCellPage, ToolCellView } from "./host-handlers"

export interface ToolTypingSelection {
  anchor: number
  head: number
  draftText: string
}

export interface ToolCellStructure {
  rowIndex: number
  contentNumber: number
  scriptureNumbering: boolean
  paragraph: { size: number; draftable: number } | null
}

export interface ToolEditorServices {
  /** The workspace's live read of the bound file (shared with the built-in
   *  editor: one fetch, one projection, one set of optimistic overlays). */
  store: CellStore
  /** True until the store holds the whole file. */
  storeLoading: boolean
  config: ToolEditorConfig
  signals: ToolCellSignals
  peers: ToolPresencePeer[]
  backtranslations: ReadonlyMap<string, ToolBacktranslation>
  selection: readonly string[]
  pericopes: readonly ToolPericope[]
  concepts: readonly Concept[]
  termMatching?: TermMatchingSettings
  /** The host's own commit pipeline (see ProjectWorkspace handleAgentTargetCommit). */
  commitTarget: (cellId: string, snapshot: { value: string; valueHtml: string }, origin: ToolOrigin) => Promise<{ autoValidated: boolean }>
  setValidation: (cellId: string, validated: boolean, origin: ToolOrigin) => Promise<boolean>
  /** The user left a cell they edited: pay any repetition propagation owed. */
  settle: (cellId: string) => void
  draft: (cellIds: string[], opts: { regenerate?: boolean }) => Promise<boolean>
  draftParagraph: (cellId: string) => Promise<boolean>
  backtranslate: (cellId: string) => Promise<boolean>
  saveBacktranslation: (cellId: string, text: string) => boolean
  openHistory: (cellId: string) => void
  openAttachments: (cellId: string) => void
  openRule: (ruleId: string, cellId: string) => void
  openTerm: (conceptId: string) => void
  openRecorder: (cellId: string) => void
  generateAudio: (cellId: string) => Promise<boolean>
  typing: (cellId: string, selection: ToolTypingSelection | null) => void
  viewing: (cellId: string | null) => void
  setSelection: (cellIds: string[]) => void
  setLane: (tag: string) => void
  setLens: (lens: ToolLens) => void
  openSettings: (section: "target-language" | "lanes" | "terminology") => void
  /** Gutter numbering + paragraph groups (editor-structure-cache.ts). */
  structureFor: (cellId: string) => ToolCellStructure
  /** The health ribbon for a cell (null when health is off). */
  ribbonFor: (cellId: string) => ToolRibbon | null
  /** Suggestion providers (ghost text): see suggestions.ts. */
  suggest: (cellId: string, prefix: string) => Promise<ToolSuggestion[]>
  suggestionFeedback: (cellId: string, suggestionId: string, accepted: boolean) => void
}

/** The cell view an editor extension gets from the shared store (apiRev 3
 *  fields included). */
export interface ToolViewExtras {
  ribbonFor?: (cellId: string) => ToolRibbon | null
  structureFor?: (cellId: string) => ToolCellStructure
  lineNumbers?: boolean
}

export function cellToToolView(store: CellStore, cell: CellData, extras: ToolViewExtras = {}): ToolCellView {
  const structure = extras.structureFor?.(cell.id)
  const footnotes = store.getCellFootnotes(cell.id)
  const ref = cell.group || cell.globalReferences?.[0] || null
  const attachments = cell.attachments ? Object.keys(cell.attachments).length : 0
  return {
    cellId: cell.id,
    ref,
    source: cell.original,
    target: cell.translated,
    validated: cell.status === "validated",
    chapter: store.getSectionLabelForCellId(cell.id) || null,
    sourceHtml: cell.originalHtml ? sanitizeSourceDisplayHtml(cell.originalHtml) : null,
    targetHtml: cell.translatedHtml ? sanitizeSourceDisplayHtml(cell.translatedHtml) : null,
    type: cell.type || null,
    lastEditor: cell.lastEditor ?? null,
    lastEditAt: cell.lastEditAt ?? null,
    aiDrafted: cell.aiDrafted === true,
    validators: [...cell.activeValidators],
    validationStatus: cell.validationStatus,
    paragraphStart: cell.paragraphStart === true,
    label: cell.cellLabel ?? null,
    context: cell.context || null,
    footnotes: {
      source: footnotes.sourceFootnotes.map((f) => ({ caller: f.caller, text: f.text })),
      target: footnotes.targetFootnotes.map((f) => ({ caller: f.caller, text: f.text })),
    },
    hasAudio: Boolean(cell.selectedAudioId),
    attachmentCount: attachments,
    hidden: cell.hidden === true,
    waivedRuleIds: (cell.waivers ?? []).map((w) => w.ruleId),
    ribbon: extras.ribbonFor?.(cell.id) ?? null,
    numberLabel: structure
      ? cellNumberLabel({
          lineNumbersEnabled: extras.lineNumbers ?? true,
          cellType: cell.type,
          canonicalRef: cell.group,
          sourceCanonicalRef: cell.globalReferences?.[0],
          scriptureNumbering: structure.scriptureNumbering,
          rowIndex: structure.rowIndex,
          contentNumber: structure.contentNumber,
          displayLabel: importDisplayLabel(cell.metadata),
        })
      : null,
    paragraph: structure?.paragraph ?? null,
  }
}

/** One page of the shared store: cursor = the index of the first cell. */
export function pageFromStore(
  store: CellStore,
  cursor: string | null,
  limit: number,
  loading: boolean,
  extras: ToolViewExtras = {},
): ToolCellPage {
  const ids = store.getCellIds()
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
  const slice = ids.slice(start, start + limit)
  const cells = store.getCellsByIds(slice).map((c) => cellToToolView(store, c, extras))
  const end = start + slice.length
  const more = end < ids.length || loading
  return { cells, nextCursor: more ? String(end) : null, total: loading ? null : ids.length }
}

export function sectionsFromStore(store: CellStore): ToolSection[] {
  return store.getNavigationIndex().map((e) => {
    // Same description the built-in navigator shows (EditorTable).
    const range = verseRangeLabel(e.cellIds, (cellId) => store.getCellView(cellId)?.group)
    const unit = e.kind === "time-range" ? "segment" : "cell"
    const description = e.kind === "story" && range
      ? `Frames ${range}`
      : (e.kind === "chapter" || e.kind === "chapter-range" || e.kind === "preface") && range
        ? `Verses ${range}`
        : `${e.total} ${unit}${e.total === 1 ? "" : "s"}`
    return {
    key: e.key,
    kind: e.kind,
    description,
    label: e.label,
    shortLabel: e.shortLabel,
    firstCellId: e.firstCellId,
    cellIds: [...e.cellIds],
    translated: e.translated,
    validated: e.validated,
    total: e.total,
    subsections: e.subsections.map((s) => ({ key: s.key, label: s.label, firstCellId: s.firstCellId, cellIds: [...s.cellIds] })),
    }
  })
}

/** Key-term matches for cells: source spans for every active concept, target
 *  spans for its renderings (forbidden ones flagged). */
export function termMatchesFor(
  store: CellStore,
  cellIds: readonly string[],
  concepts: readonly Concept[],
  termMatching?: TermMatchingSettings,
): Record<string, ToolTermMatch[]> {
  const out: Record<string, ToolTermMatch[]> = {}
  const active = concepts.filter((c) => c.status !== "deprecated" && c.sourceTerm.trim())
  if (active.length === 0) return out
  for (const cell of store.getCellsByIds(cellIds)) {
    const matches: ToolTermMatch[] = []
    for (const concept of active) {
      const renderings = concept.renderings.filter((r) => r.status !== "forbidden").map((r) => r.rendering)
      for (const m of findConceptMatches(cell.original, concept, termMatching)) {
        matches.push({ side: "source", start: m.start, end: m.end, term: concept.sourceTerm, conceptId: concept.id, renderings })
      }
      if (!cell.translated) continue
      for (const r of concept.renderings) {
        if (!r.rendering.trim()) continue
        for (const m of findConceptMatches(cell.translated, { sourceTerm: r.rendering }, termMatching)) {
          matches.push({
            side: "target", start: m.start, end: m.end, term: concept.sourceTerm, conceptId: concept.id, renderings,
            ...(r.status === "forbidden" ? { forbidden: true } : {}),
          })
        }
      }
    }
    if (matches.length > 0) out[cell.id] = dedupeOverlaps(matches)
  }
  return out
}

function dedupeOverlaps(matches: ToolTermMatch[]): ToolTermMatch[] {
  const bySide = (side: "source" | "target") =>
    matches
      .filter((m) => m.side === side)
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .filter((m, i, arr) => !arr.slice(0, i).some((p) => p.start < m.end && m.start < p.end))
  return [...bySide("source"), ...bySide("target")]
}
