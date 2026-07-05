import React, { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type OnViewableItemsChangedInfo,
} from "@legendapp/list/react"
import DOMPurify from "dompurify"
import {
  Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, RefreshCw,
  MessageCircle, Play, Pause, Mic, Sparkles, FileText, History as HistoryIcon,
  ArrowRight, Activity, NotebookPen, Info, Pencil,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import type { CellData } from "@/hooks/useCells"
import { useFileAudioAttachments, mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { getCellPref, setCellPref } from "@/lib/store/audio-cell-prefs"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord, Voice, ProjectTtsSettings, OrderedBy } from "@/lib/parsers/types"
import { sortByLens, hasTiming } from "@/lib/timeline/derive"
import { useEditorCapabilities } from "@/hooks/useProjectPermissions"
import { canPerform } from "@/lib/sync/role-policy"
import { emitTargetCellCommit, emitCellValidate, emitCellUnvalidate, emitCellWaive, emitCellUnwaive } from "@/lib/sync/events-emit"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { needsAttention, needsAttentionFromConfidence, resolveDecayConfig } from "@/lib/health/decay-engine"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { StaleSourceIndicator } from "./StaleSourceIndicator"
import { HealthRing } from "./HealthRing"
import { TranslatedEditor, type FootnoteInsertionAnchor, type TranslatedEditorHandle } from "./TranslatedEditor"
import { CellWaveform } from "./CellWaveform"
import { CellAudioButton } from "./CellAudioButton"
import { DenoiseButton } from "./audio/DenoiseButton"
import { TimelineAddMedia } from "./TimelineAddMedia"
import { CellTtsButton } from "./CellTtsButton"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellTranscribeBadge } from "./CellTranscribeBadge"
import { CellActionRail, RailButton, isInteractiveTarget } from "./CellActionRail"
import { CellExpansion } from "./CellExpansion"
import { tokenizeWords } from "@/lib/audio/timings"
import { resolveCurrentCellIndex } from "@/lib/editor/current-index"
import { useCellAudio } from "@/hooks/useCellAudio"
import { useCellEditHistory } from "@/hooks/useCellEditHistory"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  MAX_SELECTED,
  clearSelection,
  getSelectedIds,
  getSelectionAnchorId,
  setSelection,
  toggleSelected,
  useIsSelected,
} from "@/lib/audio/selection"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { CellNumberPill } from "./cell/CellNumberPill"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import { CellVoicePanel } from "./cell/CellVoicePanel"
// CellAudioRecordButton: getUnsupportedReason used by the rail mic denied-help
// popover (FRO-237). The component itself is no longer in the overflow popover.
import { getUnsupportedReason } from "./CellAudioRecordButton"
import { useMicPermission } from "@/hooks/useMicPermission"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import { isPerfLogEnabled } from "@/lib/perf-log"
import { partitionInfractions } from "@/lib/rules/waivers"
import { ViolationPopover } from "./ViolationPopover"
import { VOICE_ASSIGN_MIME } from "./VoiceLibraryPanel"
import type { RangeHighlight } from "./HighlightedText"
import { TermLookupPopover } from "./TermLookupPopover"
import type { Concept } from "@/lib/terminology/types"
import { PreAcceptanceWarningBand } from "./PreAcceptanceWarningBand"
import { detectPreAcceptanceWarnings } from "@/lib/terminology/preacceptance"
import { useFileFontSizes } from "@/lib/store/file-view-prefs"
import { useEditorActions } from "@/context/EditorActionsContext"
import { AddConceptDialog } from "./AddConceptDialog"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import { buildSourceChip, type ContextChip } from "@/lib/agent/context-chip"
import { FootnoteInline, FootnotedTextValue } from "./footnotes/FootnoteInline"
import {
  AddFootnoteDialog,
  type AddFootnoteMarkerOption,
  type AddFootnoteDialogDefaults,
  type AddFootnoteDialogValue,
  type FootnoteMarkerStyle,
} from "./footnotes/AddFootnoteDialog"
import {
  segmentUsfmForDisplay,
  clipRangesToSegment,
  type UsfmNoteSegment,
} from "@/lib/parsers/usfm-display"
import { extractUsfmFootnotes, type ExtractedFootnote } from "@/lib/footnotes/extract"
import { createUsfmFootnoteMarker } from "@/lib/footnotes/insert"
import { deleteFootnote, spliceFootnoteText } from "@/lib/footnotes/splice"
import type { FootnoteViewMode, VisibleFootnoteEntry } from "@/lib/footnotes/types"
import { hasMeaningfulRichText, prepareReadOnlyRichTextHtml } from "@/lib/richtext/editor-content"
import { findTermMatches } from "@/lib/richtext/terminology-chip-plugin"

// Per-row render counter. Always accumulated when perf logging is on (cheap)
// but NOT auto-logged — render logs would flood the console and push the
// useful health/cells/worker logs out of the 500-entry buffer. Inspect on
// demand from the console:
//
//   window.__perfRowRenders         → Map of "cellIdPrefix" → count
//   window.__perfDumpRowRenders()   → console.table of the same
const rowRenders = new Map<string, number>()
const ESTIMATED_ROW_HEIGHT_PX = 140
const LEGEND_LIST_DRAW_DISTANCE_PX = 240

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

function areNumberArraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfRowRenders = rowRenders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfDumpRowRenders = () => {
    const obj: Record<string, number> = {}
    for (const [k, v] of rowRenders) obj[k] = v
    // eslint-disable-next-line no-console
    console.table(obj)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__perfResetRowRenders = () => rowRenders.clear()
}

/** Tiny gutter badge that surfaces synth lifecycle: translating, generating,
 *  or failed. Lives in the left gutter so the loading state is anchored next
 *  to the cell that's actually working, even if the row scrolls. Errors are
 *  click-to-expand: full message + actions (set Gemini key, dismiss).
 *
 * A1: error popover body is surfaced from the first click on the badge (not
 *     just via a tooltip) and includes a plain-English recovery hint.
 * A4: dismissing the popover keeps a muted "Not voiced" badge rather than
 *     clearing the failed state entirely — cell still looks unvoiced.
 */
function SynthStatusBadge({
  status, cellId: _cellId, projectId, onOpenAudioSetup,
}: {
  status: ReturnType<typeof useTtsStatus>
  /** Retained for the call-site; no longer used inside the badge (dismiss
   *  no longer resets status via setTtsStatus — see A4). */
  cellId: string
  projectId: string
  /** Navigate to audio/voice settings so the user can fix the setup. */
  onOpenAudioSetup?: () => void
}) {
  const navigate = useNavigate()
  // A2: "Open audio setup" must DO something. When the callback is provided we
  // call it (host may already be in audio mode); otherwise we navigate directly
  // to the project settings page which contains the Gemini API key section.
  const openVoiceSetup = () =>
    onOpenAudioSetup ? onOpenAudioSetup() : navigate(`/project/${projectId}/settings`)
  // A4: track whether the user dismissed the popover without fixing the error.
  // Dismissed = popover hidden but cell is still unvoiced — show a muted badge
  // so the row doesn't look falsely clean.
  const [dismissed, setDismissed] = useState(false)
  // When a NEW error arrives (retry), reset dismissed so the popover re-opens.
  const prevMessageRef = useRef<string | null>(null)
  if (status.kind === "error" && status.message !== prevMessageRef.current) {
    prevMessageRef.current = status.message
    if (dismissed) setDismissed(false)
  }
  if (status.kind === "loading") {
    const isTranslating = status.file === "Translating…"
    const pct = !isTranslating && status.total > 0
      ? Math.round((status.loaded / status.total) * 100)
      : null
    const tooltip = isTranslating
      ? "Translating before voicing"
      : pct != null
        ? `Loading voice model (${pct}%)`
        : "Loading voice model"
    return (
      <AppTooltip content={tooltip}>
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
          <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
          {isTranslating
            ? "Translating"
            : pct != null
              ? <>Loading <span className="tabular-nums">{pct}%</span></>
              : "Loading"}
        </span>
      </AppTooltip>
    )
  }
  if (status.kind === "synthesizing") {
    return (
      <AppTooltip content="Generating audio…">
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
          <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
          Voicing
        </span>
      </AppTooltip>
    )
  }
  if (status.kind === "error") {
    const error = categorizeAiError(status.message)
    // A4: dismiss closes the popover but keeps a muted "Not voiced" badge;
    // it does NOT reset to idle so the row still looks unvoiced.
    const handleDismiss = () => setDismissed(true)
    // Voice setup (engine, Gemini key, library) now lives in the Voice Studio,
    // so recovery actions route there rather than opening an inline modal.
    const actions: Array<{ label: string; primary?: boolean; onClick: () => void }> = []
    if (error.category === "missing-gemini-key") {
      actions.push({
        label: "Open audio setup",
        primary: true,
        onClick: openVoiceSetup,
      })
    } else if (
      error.category === "translation-not-configured" ||
      error.category === "no-source-text" ||
      error.category === "git-project-unsupported" ||
      error.category === "sign-in-required"
    ) {
      // Soft fixes — the popover body explains what to do; no inline action.
    } else {
      actions.push({
        label: "Open audio setup",
        onClick: openVoiceSetup,
      })
    }

    // A4: dismissed — muted badge, no popover. Still communicates "not voiced".
    if (dismissed) {
      return (
        <AppTooltip content="Audio generation failed — click Generate to retry">
          <span className="inline-flex max-w-[80px] cursor-default items-center gap-1 truncate rounded-full bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
            Not voiced
          </span>
        </AppTooltip>
      )
    }

    // A1: full error badge + popover. The trigger label "Audio failed" is more
    // scannable than just "Failed" and the popover body is shown on first click.
    return (
      <CellAiStatusPopover
        error={error}
        actions={actions}
        onDismiss={handleDismiss}
        trigger={
          <button
            type="button"
            className="inline-flex max-w-[80px] cursor-pointer items-center gap-1 truncate rounded-full bg-destructive/15 px-1.5 py-0.5 text-[9px] font-medium text-destructive hover:bg-destructive/25"
          >
            Audio failed
          </button>
        }
      />
    )
  }
  return null
}

function ValidationHistoryTimeline({
  entries, currentUsername,
}: {
  entries: import("@/hooks/useCells").EditValidationSummary[]
  currentUsername: string
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  // entries are value-editMap only, oldest-first. The last entry IS the current
  // state (already shown above the divider), so skip it. Show remaining newest-first.
  const historical = entries.slice(0, -1).reverse()
  if (historical.length === 0) return null

  return (
    <>
      <div className="my-1 h-px bg-border" />
      <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">History</div>
      <ul className="space-y-0.5">
        {historical.map((entry, i) => {
          const snippet = typeof entry.value === "string"
            ? (entry.value.length > 40 ? entry.value.slice(0, 40) + "…" : entry.value)
            : ""
          const date = new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          const authors = entry.authors.join(", ")
          const expanded = expandedIdx === i
          return (
            <li key={`${entry.timestamp}-${i}`} className="rounded text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left hover:bg-muted/50"
                onClick={() => setExpandedIdx(expanded ? null : i)}
              >
                <span className="truncate">
                  <span className="text-muted-foreground">{date} · </span>
                  <span>{authors}</span>
                </span>
              </button>
              {snippet && (
                <div className="px-1 pb-1 text-[11px] italic text-muted-foreground/80 truncate">"{snippet}"</div>
              )}
              {expanded && (
                <ul className="border-l border-border/50 pl-2 ml-1 mb-1 space-y-0.5">
                  {entry.validatorsAll.length === 0 ? (
                    <li className="px-1 py-0.5 text-[11px] text-muted-foreground/60">No validators on this state</li>
                  ) : entry.validatorsAll.map(v => (
                    <li
                      key={v.username}
                      className={cn(
                        "px-1 py-0.5 text-[11px] flex items-center gap-1",
                        v.isDeleted && "text-muted-foreground/50 line-through",
                      )}
                    >
                      <span>{v.username}{v.username === currentUsername ? " (you)" : ""}</span>
                      <span className="text-muted-foreground/60 ml-auto">
                        {new Date(v.updatedTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

// Stable empty sentinels so per-cell "map.get(id) ?? []" derivations keep a
// steady reference when the cell has no entry — otherwise every render would
// mint a fresh [] and break React.memo for every row.
const EMPTY_EXAMPLES: ScoredPair[] = []
const EMPTY_INFRACTIONS: RuleInfraction[] = []
const EMPTY_HIGHLIGHTS: ReturnType<typeof buildHighlightsFromExamples> = []
const SELECTION_DRAG_THRESHOLD_PX = 3
const SELECTION_EDGE_SCROLL_ZONE_PX = 56
const SELECTION_EDGE_SCROLL_STEP_PX = 22

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  focusCellEditorIndex: (index: number) => void
  getCurrentIndex?: () => number
  /** Briefly outline a cell after a "Go to cell" so the user sees where the search landed. */
  flashCell: (cellId: string, searchTerm: string) => void
}

/** Per-cell audio production data + actions, supplied only when the editor is
 *  in the Audio lens. When null/undefined the editor renders plain text mode.
 *  In Audio mode each cell's SOURCE column is replaced with CellVoicePanel —
 *  the full per-line voice controls (character picker, generate, play, make-a-
 *  character) — so this context carries everything that panel needs. */
export interface AudioLensContext {
  voices: Voice[]
  /** Hydrated TTS settings (cast assignments) — source of truth for who voices a line. */
  settings: ProjectTtsSettings | undefined
  /** The project's default/narrator voice id, used when a line has no explicit cast. */
  defaultVoiceId: string
  /** The TTS-overlaid project record (real engine/key/cast) used for generation. */
  project: ProjectRecord
  projectId: string
  /** Frontier session for synth/playback token minting (kept opaque for the panel). */
  session: unknown
  username: string
  onAssignCast: (cellId: string, voiceId: string) => void
  /** Revalidate after a successful per-cell generate. */
  onAfterGenerate: () => void
  /** Play just this one cell through the shared play-queue. Pass the audio-
   *  enriched cell (carries selectedGeneratedVoiceAudioId + attachments) so the
   *  play-queue can resolve a take; the raw cell row alone cannot, which
   *  silently stalls play right after a generate. */
  onPlayCell: (cellId: string, enrichedCell?: CellData) => void
  /** Open the "make a character from this voice" flow seeded with this cell's take. */
  onMakeCharacterFromCell: (cellId: string) => void
}

interface EditorTableProps {
  project: ProjectRecord
  cells: CellData[]
  username: string
  /** When set, each row shows the Audio-lens strip (speaker chip + generate). */
  audioLens?: AudioLensContext | null
  /** Timeline-segment-model: the active file's order lens. When `'time'`, the
   *  Text/Audio toggle becomes a Text-layer / Media-layer switch — the row list
   *  filters by segment `medium` and sorts by timing. Absent or `'sequence'`
   *  ⇒ today's behavior (no filtering, no reorder). */
  orderedBy?: OrderedBy
  /** Switch to the Audio lens and open the cast/voice library (error recovery). */
  onOpenAudioSetup?: () => void
  /** Media-lens empty state: attach a clip to THIS file (upload / direct URL).
   *  When absent, the empty state falls back to the static hint. */
  onAttachMediaFile?: (file: File) => Promise<void>
  onAttachMediaUrl?: (url: string) => Promise<void>
  /** Called after a successful `target.cell.commit` enqueue so the parent
   *  refetches the cells projection. `committedEventId` is the event id the
   *  commit was assigned (known only here, before the projection round-trip);
   *  the parent's auto-BT pins to it so the BT isn't instantly stale. */
  onCellCommitted?: (cellId: string, committedEventId?: string) => void | Promise<void>
  /** Optimistic local patch fired BEFORE the outbox enqueue so the editor's
   *  rule infractions + per-cell UI re-derive instantly without waiting for
   *  the projection round-trip. The follow-up `onCellCommitted` -> revalidate
   *  overwrites this with the authoritative server projection. */
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  /** Map of cellId → presence holder label. When present, the cell editor
   *  goes read-only with an "Alice is editing" banner. */
  cellLockHolders?: ReadonlyMap<string, string>
  /** Cell ids whose remote value changed while this client held the focus
   *  lock — surfaces the discard-and-reload banner. */
  cellsWithRemoteChange?: ReadonlySet<string>
  /** Parent-managed focus claim/release (per-cell). */
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  /** Drop the "remote-changed-while-editing" flag for a cell. */
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  completing: Map<string, string>
  examples: Map<string, ScoredPair[]>
  errors: Map<string, string>
  /** Streaming completion text keyed by cell id. Populated chunk-by-chunk
   *  by `useCompletion.completeSingle`; rendered in the target column as a
   *  non-editable overlay while `completing` is "searching"/"generating"
   *  so the user sees progress immediately instead of waiting for the
   *  commit + outbox flush to land. */
  previews: Map<string, string>
  onCompleteSingle: (cell: CellData) => void
  onCompleteBatch: (cells: CellData[]) => void
  healthMap: Map<string, number>
  infractions?: Map<string, RuleInfraction[]>
  rules?: TranslationRule[]
  // onInfractionClick moved to EditorActionsContext (FRO perf cleanup) — pure
  // pass-through, never consumed above the row.
  isBacktranslationConfigured?: boolean
  onBacktranslate?: (cell: CellData, polish?: boolean) => void
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  /** Called when user saves a BT edit. Parent emits `cell.backtranslation.set`. */
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  cellOpenCommentCount?: Map<string, number>
  // onOpenComments/onOpenHistory moved to EditorActionsContext (FRO perf
  // cleanup) — pure pass-through, never consumed above the row.
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  // onAiSetupNeeded/onOpenRecording moved to EditorActionsContext (FRO perf
  // cleanup) — pure pass-through, never consumed above the row.
  /** Re-read the project record from IDB after a settings change (e.g. voice library edits). */
  onProjectChanged?: () => void
  /** Add-from-selection: create a DRAFT concept from a selected source token. */
  onAddConceptFromSelection?: (sourceTerm: string) => void | Promise<void>
  onAskAiFromSelection?: (chip: ContextChip) => void
  /** Called when the user drops a voice chip onto a cell's audio area.
   *  Parent should assign the voice then trigger TTS generation. */
  onAssignVoice?: (cellId: string, voiceId: string) => void
  /** Phase 5 / AD-9 — set of cell ids whose source has advanced since the
   *  translator's last commit. When provided, each row renders the small
   *  StaleSourceIndicator badge next to its validation status. Parent fetches
   *  once per file via `useStaleSourceCells` so we don't issue N requests. */
  staleCellIds?: ReadonlySet<string>
  /** Token fetcher for project-scoped sync reads. Required for the inline
   *  History tab to query the D1 event log on demand. */
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** FRO-207: Lazily returns the interlinear alignment model for source↔target
   *  token alignment in the BT expansion tab. Built by ProjectWorkspace from
   *  all project cell pairs + persisted seeds only when the panel opens. */
  getAlignmentModel?: () => import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when the user confirms or invalidates an alignment seed.
   *  Parent persists via project-settings and rebuilds the model. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
  /** FRO-192: Map of cellId → {username, scopeLabel} for cells that have an
   *  active assignment. The map is built in ProjectWorkspace from getMyAssignments
   *  (member's own inbox) and getProjectAssignments (manager workload). */
  assignmentsByCellId?: ReadonlyMap<string, { username: string; scopeLabel: string }>
  /** Fired when the first visible row's canonical ref changes while scrolling
   *  (e.g. "GEN 1:1"). Drives the parallel-bibles sidebar's auto-tracking.
   *  Null when the visible cell carries no ref. */
  onVisibleRefChange?: (ref: string | null) => void
  /**
   * RACE-5: ref-backed lock check for commit-time enforcement. Reads the live
   * lock map (updated synchronously on each WS frame) so a commit queued just
   * after a `lock.claimed` frame arrives can't slip through a stale React render.
   * Returns the holder userId/label, or null when the cell is free.
   * Optional — when absent the existing `lockHolderLabel` prop is the only guard.
   */
  checkLockHolder?: (cellId: string) => string | null
  /**
   * FRO-317: when true, USFM \f...\f* footnotes render as a distinct panel
   * immediately below each cell row. Editing is safe only for USFM files.
   */
  showFootnotesInline?: boolean
  /** True when a full footnote surface is active, so source chips stay markers only. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** Emits USFM footnotes from the currently visible virtual rows. */
  onVisibleFootnotesChange?: (entries: VisibleFootnoteEntry[]) => void
  /** Called after a target footnote is created so the parent can reveal footnotes. */
  onFootnoteCreated?: () => void
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cells, username, isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors, previews,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [],
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  onSaveBacktranslation,
  cellOpenCommentCount,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection,
  isAnonymous, onJumpToCell,
  audioLens, onOpenAudioSetup,
  onAttachMediaFile, onAttachMediaUrl,
  orderedBy,
  onProjectChanged, onAddConceptFromSelection, onAskAiFromSelection, onAssignVoice,
  onCellCommitted,
  onOptimisticEdit,
  cellLockHolders,
  cellsWithRemoteChange,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  staleCellIds,
  getTokenForFile,
  getAlignmentModel,
  onAlignmentSeedChange,
  assignmentsByCellId,
  checkLockHolder,
  showFootnotesInline,
  footnotePanelActive,
  footnoteViewMode = "off",
  onVisibleRefChange,
  onVisibleFootnotesChange,
  onFootnoteCreated,
}, ref) {
  const { canEdit, canValidate, readOnlyLabel } = useEditorCapabilities(project)
  // Probe mic permission once (shared across all rows) so the help affordance
  // on CellAudioRecordButton activates when the user has blocked the mic.
  const { micDenied } = useMicPermission(audioLens !== null)
  const parentRef = useRef<HTMLElement | null>(null)
  const listRootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<LegendListRef | null>(null)
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0)
  const [viewableIndexes, setViewableIndexes] = useState<number[]>([])
  const [activeEditorCellId, setActiveEditorCellId] = useState<string | null>(null)
  // Mirror ref so the imperative handle (getCurrentIndex) reads current
  // values without widening its dependency array — same pattern as
  // displayCellsRef below.
  const viewableIndexesRef = useRef(viewableIndexes)
  viewableIndexesRef.current = viewableIndexes
  // Last cell whose editor was activated (jump target or clicked-into cell).
  // Deliberately NOT cleared on blur/deactivate: clicking the "Next
  // unfinished" menu item blurs the editor before the click lands, and the
  // user's position shouldn't evaporate at that instant. getCurrentIndex
  // ignores it once the cell is off screen or no longer rendered.
  const lastActiveEditorCellIdRef = useRef<string | null>(null)
  const [hoveredFootnote, setHoveredFootnote] = useState<{ cellId: string; index: number } | null>(null)
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())
  const cellsRef = useRef(cells)
  const selectionDragRef = useRef<{
    pointerId: number
    anchorIndex: number
    lastIndex: number
    startX: number
    startY: number
    didDrag: boolean
    clickAction: "clear-single" | null
  } | null>(null)
  const selectionDragAbortRef = useRef<AbortController | null>(null)
  const selectionAutoScrollFrameRef = useRef<number | null>(null)
  const selectionPointerYRef = useRef<number | null>(null)
  const previousBodyUserSelectRef = useRef<string | null>(null)

  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  // Durable cell audio (AD-2 cell.audio.* grammar). Per-file read; overlay each
  // cell's attachments + selected clips onto CellData so the existing audio
  // controllers (which read cell.attachments / selectedAudioId) light up.
  const audioFileId = cells[0]?.fileId ?? null
  const { byCellId: audioByCellId } = useFileAudioAttachments(project.id, audioFileId)
  const cellsWithAudio = useMemo(
    () => mergeCellsWithAudio(cells, audioByCellId),
    [cells, audioByCellId],
  )

  // Timeline-segment-model (Scope A): the rendered row list. For a `'time'`-
  // ordered file the Text/Audio toggle is a medium-LAYER switch — Text layer
  // shows text segments, Audio (Media) layer shows media segments — and rows
  // sort by timing. For every other file this is byte-identical to today
  // (no filter, no reorder), so existing projects are untouched.
  //
  // NOTE: only the virtual row list is filtered here. Index-based voice paths
  // (getVoiceTakeCells / cellsRef) intentionally stay on the full cell list;
  // combined-voice-by-index on a time-ordered media layer is a known Part-B
  // limitation, not exercised by Scope A's single-clip media import.
  const isTimeOrdered = orderedBy === "time"
  const displayCells = useMemo(() => {
    if (!isTimeOrdered) return cellsWithAudio
    const wantMedia = !!audioLens
    const filtered = cellsWithAudio.filter((c) =>
      wantMedia ? c.medium === "media" : (c.medium ?? "text") !== "media"
    )
    return sortByLens(filtered, "time")
  }, [cellsWithAudio, isTimeOrdered, audioLens])
  const displayCellsRef = useRef(displayCells)
  displayCellsRef.current = displayCells

  useEffect(() => {
    if (!activeEditorCellId) return
    if (displayCells.some((cell) => cell.id === activeEditorCellId)) return
    setActiveEditorCellId(null)
  }, [activeEditorCellId, displayCells])

  const handleActivateEditor = useCallback((cellId: string) => {
    setActiveEditorCellId(cellId)
    lastActiveEditorCellIdRef.current = cellId
  }, [])

  const handleDeactivateEditor = useCallback((cellId: string) => {
    setActiveEditorCellId((current) => current === cellId ? null : current)
  }, [])

  // Hydrate the per-cell trim cache (localStorage, seconds — what the player
  // reads) from the server attachment's trim (ms). Server is authoritative on
  // load, so combined/cropped slices set on another device appear here.
  useEffect(() => {
    for (const [cellId, entry] of audioByCellId) {
      const sel = entry.selectedAudioId ?? entry.selectedGeneratedVoiceAudioId
      if (!sel) continue
      const att = entry.attachments[sel]
      if (!att || (att.trimStartMs == null && att.trimEndMs == null)) continue
      const start = att.trimStartMs != null ? att.trimStartMs / 1000 : undefined
      const end = att.trimEndMs != null ? att.trimEndMs / 1000 : undefined
      const cur = getCellPref(project.id, cellId)
      if (cur?.trimStart === start && cur?.trimEnd === end) continue
      setCellPref(project.id, cellId, { trimStart: start, trimEnd: end })
    }
  }, [audioByCellId, project.id])

  const ruleMap = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules])

  // FRO-251: per-file, per-side font size. Persisted in localStorage keyed by
  // fileId; adjusted from the View settings (eye) menu in the header.
  const editorFileId = cells[0]?.fileId ?? null
  const { source: sourceFontSize, target: targetFontSize } = useFileFontSizes(editorFileId)

  const setListScrollElement = useCallback((node: unknown) => {
    parentRef.current = node instanceof HTMLElement ? node : null
  }, [])
  const getListQueryRoot = useCallback(() => parentRef.current ?? listRootRef.current, [])

  // FRO-250: sticky chapter indicator. Derives the "current section" label from
  // Legend List's first visible item so the reader always knows which chapter/
  // section they're in without scrolling back to a section heading.
  const sectionByIndex = useMemo(() => {
    const out: string[] = []
    let lastLabel = ""
    for (const cell of displayCells) {
      const firstRef = cell.globalReferences?.find((r) => r && r.trim().length > 0)
      if (firstRef) {
        const colon = firstRef.indexOf(":")
        lastLabel = (colon >= 0 ? firstRef.slice(0, colon) : firstRef).trim()
      } else if (cell.section?.trim()) {
        lastLabel = cell.section.trim()
      }
      out.push(lastLabel)
    }
    return out
  }, [displayCells])

  useEffect(() => {
    setFirstVisibleIndex((current) => clampIndex(current, displayCells.length))
    setViewableIndexes((current) => {
      const next = current.filter((index) => index >= 0 && index < displayCells.length)
      return next.length === current.length ? current : next
    })
  }, [displayCells.length])

  const clampCellIndex = useCallback((index: number) => {
    const last = cellsRef.current.length - 1
    if (last < 0) return -1
    return Math.max(0, Math.min(last, index))
  }, [])

  // Move keyboard focus into the target editor at `index`, placing the caret
  // at the end. Legend List may recycle/mount the destination row a frame or
  // two after scrollToIndex, so retry briefly until the DOM node exists.
  const focusCellEditorByIndex = useCallback((index: number) => {
    const list = displayCellsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index].id
    setActiveEditorCellId(targetId)
    lastActiveEditorCellIdRef.current = targetId
    void listRef.current?.scrollToIndex({
      index,
      viewPosition: 0.5,
      animated: false,
    })

    let attempts = 0
    const focusWhenMounted = () => {
      const root = getListQueryRoot()
      if (!root) return
      const pm = root.querySelector<HTMLElement>(
        `[data-cell-id="${CSS.escape(targetId)}"] .ProseMirror`,
      )
      if (!pm) {
        if (attempts < 8) {
          attempts += 1
          requestAnimationFrame(focusWhenMounted)
        }
        return
      }
      pm.focus()
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(pm)
        range.collapse(false) // collapse to end
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    focusWhenMounted()
  }, [getListQueryRoot])

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < displayCells.length) {
        void listRef.current?.scrollToIndex({
          index,
          viewPosition: 0.5,
          animated: false,
        })
      }
    },
    focusCellEditorIndex: focusCellEditorByIndex,
    getCurrentIndex: () => {
      // The last-active editor cell when it's on screen (so "Next unfinished"
      // advances past a just-jumped-to cell instead of re-finding it),
      // otherwise the first visible row — mapped from display space back to
      // the `cells` prop space the search indexes into. Pure logic lives in
      // lib/editor/current-index.ts where it's testable.
      const state = listRef.current?.getState()
      const scrollEl = parentRef.current ?? listRootRef.current
      return resolveCurrentCellIndex({
        displayCells: displayCellsRef.current,
        cells: cellsRef.current,
        activeCellId: lastActiveEditorCellIdRef.current,
        viewableIndexes: viewableIndexesRef.current,
        measurements: state
          ? {
              scroll: state.scroll,
              positionAtIndex: (index) => state.positionAtIndex(index),
              sizeAtIndex: (index) => state.sizeAtIndex(index),
            }
          : null,
        fallbackScrollTop: scrollEl?.scrollTop ?? 0,
        estimatedRowHeight: ESTIMATED_ROW_HEIGHT_PX,
      })
    },
    flashCell(cellId, _searchTerm) {
      // Defer to next frame: the list may still be scrolling, so the
      // DOM node we want might not exist yet.
      requestAnimationFrame(() => {
        const root = getListQueryRoot()
        if (!root) return
        const el = root.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`)
        if (!el) return
        el.classList.add("codex-search-flash")
        window.setTimeout(() => el.classList.remove("codex-search-flash"), 1800)
      })
    },
  }), [displayCells.length, focusCellEditorByIndex, getListQueryRoot])

  // FRO-297: Focus the grid-row wrapper div (not TipTap) at `index`.
  // Used for Esc-to-grid and arrow-key navigation while NOT in edit mode.
  // The wrapper div has tabIndex={0} so it can receive programmatic focus.
  const focusGridRowByIndex = useCallback((index: number) => {
    const list = displayCellsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index].id
    void listRef.current?.scrollToIndex({
      index,
      viewPosition: 0.5,
      animated: false,
    })
    let attempts = 0
    const focusWhenMounted = () => {
      const root = getListQueryRoot()
      if (!root) return
      const rowEl = root.querySelector<HTMLElement>(
        `[data-cell-id="${CSS.escape(targetId)}"] [data-grid-row]`,
      )
      if (!rowEl) {
        if (attempts < 8) {
          attempts += 1
          requestAnimationFrame(focusWhenMounted)
        }
        return
      }
      rowEl.focus()
    }
    focusWhenMounted()
  }, [getListQueryRoot])

  // Resolve a navigation request from a cell editor (Up/Down/Tab) to the
  // adjacent cell and focus it. Out-of-range steps (top/bottom edge) no-op.
  const handleNavigateCell = useCallback((cellId: string, direction: "prev" | "next") => {
    const idx = displayCellsRef.current.findIndex((c) => c.id === cellId)
    if (idx < 0) return
    focusCellEditorByIndex(direction === "next" ? idx + 1 : idx - 1)
  }, [focusCellEditorByIndex])

  // FRO-297: Esc from a cell editor — commit-and-return to grid row focus.
  const handleEscapeToGrid = useCallback((cellId: string) => {
    const idx = displayCellsRef.current.findIndex((c) => c.id === cellId)
    if (idx < 0) return
    focusGridRowByIndex(idx)
  }, [focusGridRowByIndex])

  // FRO-297: Arrow-key (or j/k) navigation within the grid (row focused, not TipTap).
  // This is called from the row's own keydown when focus is on the grid row wrapper.
  const handleGridRowKeyNav = useCallback((cellId: string, direction: "prev" | "next") => {
    const idx = displayCellsRef.current.findIndex((c) => c.id === cellId)
    if (idx < 0) return
    focusGridRowByIndex(direction === "next" ? idx + 1 : idx - 1)
  }, [focusGridRowByIndex])

  const selectRangeByIndexes = useCallback((anchorIndex: number, focusIndex: number) => {
    const list = displayCellsRef.current
    if (list.length === 0) return
    const anchor = clampIndex(anchorIndex, list.length)
    const focus = clampIndex(focusIndex, list.length)
    if (anchor < 0 || focus < 0) return

    const start = focus >= anchor
      ? anchor
      : Math.max(focus, anchor - MAX_SELECTED + 1)
    const end = focus >= anchor
      ? Math.min(focus, anchor + MAX_SELECTED - 1)
      : anchor
    const ids = list.slice(start, end + 1).map((c) => c.id)
    setSelection(ids, list[anchor]?.id ?? ids[0] ?? null)
  }, [])

  const getIndexAtClientY = useCallback((clientY: number) => {
    const scrollEl = parentRef.current ?? listRootRef.current
    const list = displayCellsRef.current
    if (!scrollEl || list.length === 0) return -1

    const root = getListQueryRoot()
    const rowEls = root
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-cell-id][data-index]"))
      : []
    let nearestDomIndex = -1
    let nearestDomDistance = Number.POSITIVE_INFINITY
    for (const rowEl of rowEls) {
      const indexAttr = rowEl.dataset.index
      if (indexAttr == null) continue
      const index = Number(indexAttr)
      if (!Number.isInteger(index) || index < 0 || index >= list.length) continue
      const rect = rowEl.getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) return index
      const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom
      if (distance < nearestDomDistance) {
        nearestDomIndex = index
        nearestDomDistance = distance
      }
    }
    if (nearestDomIndex >= 0) return nearestDomIndex

    const rect = scrollEl.getBoundingClientRect()
    const yWithin = Math.max(0, Math.min(rect.height, clientY - rect.top))
    const state = listRef.current?.getState()
    const y = (state?.scroll ?? scrollEl.scrollTop) + yWithin
    if (!state) return clampIndex(Math.round(y / ESTIMATED_ROW_HEIGHT_PX), list.length)

    let nearestIndex = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < list.length; index += 1) {
      const start = state.positionAtIndex(index)
      const size = state.sizeAtIndex(index) || ESTIMATED_ROW_HEIGHT_PX
      const end = start + size
      if (y >= start && y <= end) return clampCellIndex(index)
      const distance = y < start ? start - y : y - end
      if (distance < nearestDistance) {
        nearestIndex = index
        nearestDistance = distance
      }
    }
    return clampIndex(nearestIndex, list.length)
  }, [getListQueryRoot])

  const updateSelectionFromPointer = useCallback((clientY: number) => {
    const drag = selectionDragRef.current
    if (!drag) return
    const nextIndex = getIndexAtClientY(clientY)
    if (nextIndex < 0 || nextIndex === drag.lastIndex) return
    drag.lastIndex = nextIndex
    selectRangeByIndexes(drag.anchorIndex, nextIndex)
  }, [getIndexAtClientY, selectRangeByIndexes])

  const scrollSelectionNearEdge = useCallback((clientY: number) => {
    const scrollEl = parentRef.current ?? listRootRef.current
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    let delta = 0
    if (clientY < rect.top + SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = -SELECTION_EDGE_SCROLL_STEP_PX
    } else if (clientY > rect.bottom - SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = SELECTION_EDGE_SCROLL_STEP_PX
    }
    if (delta !== 0) {
      const current = listRef.current?.getState()?.scroll ?? scrollEl.scrollTop
      void listRef.current?.scrollToOffset({
        offset: Math.max(0, current + delta),
        animated: false,
      })
    }
  }, [])

  const stopSelectionDrag = useCallback(() => {
    selectionDragAbortRef.current?.abort()
    selectionDragAbortRef.current = null
    selectionDragRef.current = null
    selectionPointerYRef.current = null
    if (selectionAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current)
      selectionAutoScrollFrameRef.current = null
    }
    if (previousBodyUserSelectRef.current !== null) {
      document.body.style.userSelect = previousBodyUserSelectRef.current
      previousBodyUserSelectRef.current = null
    }
  }, [])

  const handleSelectionPointerMove = useCallback((e: PointerEvent) => {
    const drag = selectionDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    e.preventDefault()
    selectionPointerYRef.current = e.clientY
    if (
      !drag.didDrag &&
      (Math.abs(e.clientX - drag.startX) > SELECTION_DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - drag.startY) > SELECTION_DRAG_THRESHOLD_PX)
    ) {
      drag.didDrag = true
    }
    updateSelectionFromPointer(e.clientY)
  }, [updateSelectionFromPointer])

  const handleSelectionPointerEnd = useCallback((e: PointerEvent) => {
    const drag = selectionDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    e.preventDefault()
    if (!drag.didDrag && drag.clickAction === "clear-single") {
      clearSelection()
    }
    stopSelectionDrag()
  }, [stopSelectionDrag])

  const startSelectionAutoScroll = useCallback(() => {
    if (selectionAutoScrollFrameRef.current !== null) return
    const tick = () => {
      if (!selectionDragRef.current) {
        selectionAutoScrollFrameRef.current = null
        return
      }
      const y = selectionPointerYRef.current
      if (typeof y === "number") {
        scrollSelectionNearEdge(y)
        updateSelectionFromPointer(y)
      }
      selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
    }
    selectionAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
  }, [scrollSelectionNearEdge, updateSelectionFromPointer])

  const handleSelectionPointerDown = useCallback((
    cellId: string,
    rowIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    stopSelectionDrag()

    const selectedIds = getSelectedIds()
    const isAdditive = e.metaKey || e.ctrlKey
    const isAlreadySelected = selectedIds.has(cellId)
    const anchorId = getSelectionAnchorId()
    const anchorIndex = displayCellsRef.current.findIndex((cell) => cell.id === anchorId)
    const shouldRange =
      !isAdditive &&
      anchorIndex >= 0 &&
      (e.shiftKey || (selectedIds.size > 0 && !isAlreadySelected))
    const startIndex = shouldRange ? anchorIndex : rowIndex

    selectionDragRef.current = {
      pointerId: e.pointerId,
      anchorIndex: clampIndex(startIndex, displayCellsRef.current.length),
      lastIndex: clampIndex(rowIndex, displayCellsRef.current.length),
      startX: e.clientX,
      startY: e.clientY,
      didDrag: false,
      clickAction: isAlreadySelected && selectedIds.size === 1 ? "clear-single" : null,
    }
    selectionPointerYRef.current = e.clientY

    previousBodyUserSelectRef.current = document.body.style.userSelect
    document.body.style.userSelect = "none"

    const controller = new AbortController()
    selectionDragAbortRef.current = controller
    window.addEventListener("pointermove", handleSelectionPointerMove, {
      signal: controller.signal,
      capture: true,
    })
    window.addEventListener("pointerup", handleSelectionPointerEnd, {
      signal: controller.signal,
      capture: true,
    })
    window.addEventListener("pointercancel", handleSelectionPointerEnd, {
      signal: controller.signal,
      capture: true,
    })

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture is a best-effort guard; window listeners still carry
      // the drag if the browser refuses capture for any reason.
    }

    if (isAdditive) {
      toggleSelected(cellId)
    } else if (shouldRange) {
      selectRangeByIndexes(anchorIndex, rowIndex)
    } else if (isAlreadySelected && selectedIds.size === 1) {
      // Defer clearing until pointerup. If the user drags from the selected
      // anchor, the move handler should extend the range instead.
    } else {
      setSelection([cellId], cellId)
    }
    startSelectionAutoScroll()
  }, [
    handleSelectionPointerEnd,
    handleSelectionPointerMove,
    selectRangeByIndexes,
    startSelectionAutoScroll,
    stopSelectionDrag,
  ])

  useEffect(() => stopSelectionDrag, [stopSelectionDrag])

  // Grid layout: [left-gutter] [source] [target]. The left 44px gutter holds
  // only the line number / cell label and the validation pill. There is no
  // right gutter — the floating action rail (sparkle / mic / tts / comment /
  // expand) is absolutely positioned at the row's right edge so it doesn't
  // claim layout space when collapsed. The target column reserves pr-9 so the
  // ever-present expand chevron never overlaps text.
  const gridCols = "grid-cols-[44px_1fr_1fr]"

  const handleMouseUp = useCallback(() => {
    if (isDragging.current && dragCells.current.size > 1) {
      const selected = cells.filter((c) => dragCells.current.has(c.id))
      onCompleteBatch(selected)
    }
    isDragging.current = false
    dragCells.current = new Set()
  }, [cells, onCompleteBatch])

  // Stable drag handlers keyed by cellId. Inline closures per row would mint
  // a fresh function every render and defeat React.memo on MemoizedRow.
  const handleDragStart = useCallback((cellId: string) => {
    isDragging.current = true
    dragCells.current = new Set([cellId])
  }, [])
  const handleDragEnter = useCallback((cellId: string) => {
    if (isDragging.current) dragCells.current.add(cellId)
  }, [])
  const getVoiceTakeCells = useCallback((startIndex: number, count: number) => {
    return cellsRef.current.slice(startIndex, startIndex + count)
  }, [])

  const currentSectionLabel = sectionByIndex[firstVisibleIndex] ?? ""

  // Parallel-bibles sidebar tracking: report the first visible row's canonical
  // ref as the user scrolls. Keyed on the derived ref string
  // so the effect only fires on actual row changes, not every scrolled pixel.
  const firstVisibleRef = displayCells[firstVisibleIndex]?.group || null
  useEffect(() => {
    onVisibleRefChange?.(firstVisibleRef)
  }, [firstVisibleRef, onVisibleRefChange])

  const footnoteNumberOffsets = useMemo(() => {
    const offsets = new Map<string, { source: number; target: number }>()
    const countsByScope = new Map<string, { source: number; target: number }>()

    for (const cell of displayCells) {
      const scopeKey = footnoteScopeKey(cell)
      const counts = countsByScope.get(scopeKey) ?? { source: 0, target: 0 }
      offsets.set(cell.id, { source: counts.source, target: counts.target })
      counts.source += countNumericFootnotes(cell.original ?? "")
      counts.target += countNumericFootnotes(cell.translated ?? "")
      countsByScope.set(scopeKey, counts)
    }

    return offsets
  }, [displayCells])

  const visibleFootnoteEntries = useMemo<VisibleFootnoteEntry[]>(() => {
    if (!onVisibleFootnotesChange || displayCells.length === 0) return []

    const indexes = viewableIndexes.length > 0 ? viewableIndexes : [firstVisibleIndex]
    return indexes
      .map((index) => {
        const cell = displayCells[index]
        if (!cell) return null
        const sourceFootnotes = extractUsfmFootnotes(cell.original ?? "")
        const targetFootnotes = extractUsfmFootnotes(cell.translated ?? "")
        if (sourceFootnotes.length === 0 && targetFootnotes.length === 0) return null
        return {
          cellId: cell.id,
          cellLabel: cell.cellLabel || String(index + 1),
          cellRef: humanFootnoteCellRef(cell),
          rowIndex: index,
          sourceFootnotes,
          targetFootnotes,
          activeFootnoteIndex: hoveredFootnote?.cellId === cell.id ? hoveredFootnote.index : null,
          isDocx: (cell.fileId ?? "").endsWith(".docx"),
          numberOffset: footnoteNumberOffsets.get(cell.id)?.target ?? 0,
        }
      })
      .filter((entry): entry is VisibleFootnoteEntry => entry !== null)
  }, [displayCells, firstVisibleIndex, footnoteNumberOffsets, hoveredFootnote, onVisibleFootnotesChange, viewableIndexes])

  useEffect(() => {
    onVisibleFootnotesChange?.(visibleFootnoteEntries)
  }, [onVisibleFootnotesChange, visibleFootnoteEntries])

  useEffect(() => () => {
    onVisibleFootnotesChange?.([])
  }, [onVisibleFootnotesChange])

  const handleFirstVisibleItemChanged = useCallback((info: {
    index: number
    item: CellData
    key: string
  }) => {
    setFirstVisibleIndex(clampIndex(info.index, displayCells.length))
  }, [displayCells.length])

  const handleViewableItemsChanged = useCallback((info: OnViewableItemsChangedInfo<CellData>) => {
    const next = info.viewableItems
      .map((item) => item.index)
      .filter((index) => index >= 0 && index < displayCells.length)
      .sort((a, b) => a - b)
    setViewableIndexes((current) => areNumberArraysEqual(current, next) ? current : next)
  }, [displayCells.length])

  const renderListItem = useCallback(({ item: cell, index }: LegendListRenderItemProps<CellData>) => {
    const untimedInTimeLens = isTimeOrdered && !hasTiming(cell)
    return (
      <div
        data-cell-id={cell.id}
        data-index={index}
        data-untimed={untimedInTimeLens ? "true" : undefined}
        aria-label={untimedInTimeLens ? "No specific timing — ordered by sequence" : undefined}
        className={cn("relative", untimedInTimeLens && "border-l-2 border-dashed border-amber-400/70")}
      >
        {untimedInTimeLens && (
          <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-amber-400/15 px-1 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            no timing
          </span>
        )}
        <MemoizedRow
          key={cell.id}
          project={project}
          cell={cell}
          isEditorActive={activeEditorCellId === cell.id}
          onActivateEditor={handleActivateEditor}
          onDeactivateEditor={handleDeactivateEditor}
          isStaleSource={staleCellIds?.has(cell.id) ?? false}
          username={username}
          editable={canEdit}
          canValidate={canValidate}
          onCellCommitted={onCellCommitted}
          onOptimisticEdit={onOptimisticEdit}
          lockHolderLabel={cellLockHolders?.get(cell.id) ?? null}
          remoteChangedWhileFocused={cellsWithRemoteChange?.has(cell.id) ?? false}
          onClaimCell={onClaimCell}
          onReleaseCell={onReleaseCell}
          onAckRemoteChange={onAckRemoteChange}
          isCompletionConfigured={isCompletionConfigured}
          isCompletionAvailable={isCompletionAvailable}
          examples={examples}
          completing={completing}
          errors={errors}
          previews={previews}
          healthMap={healthMap}
          infractions={infractions}
          ruleMap={ruleMap}
          onCompleteSingle={onCompleteSingle}
          isBacktranslationConfigured={isBacktranslationConfigured}
          backtranslating={backtranslating}
          backtranslationErrors={backtranslationErrors}
          onBacktranslate={onBacktranslate}
          onSaveBacktranslation={onSaveBacktranslation}
          cellOpenCommentCount={cellOpenCommentCount}
          activeCueIndex={activeCueIndex}
          onSeekToCue={onSeekToCue}
          rowIndex={index}
          lineNumbersEnabled={lineNumbersEnabled}
          cellLabelsEnabled={cellLabelsEnabled}
          sourceTextDirection={sourceTextDirection}
          targetTextDirection={targetTextDirection}
          gridCols={gridCols}
          isAnonymous={isAnonymous}
          onJumpToCell={onJumpToCell}
          micDenied={micDenied}
          audioLens={audioLens ?? null}
          onOpenAudioSetup={onOpenAudioSetup}
          onProjectChanged={onProjectChanged}
          onAddConceptFromSelection={onAddConceptFromSelection}
          onAskAiFromSelection={onAskAiFromSelection}
          onAssignVoice={onAssignVoice}
          onDragStart={handleDragStart}
          onDragEnter={handleDragEnter}
          onSelectionPointerDown={handleSelectionPointerDown}
          onNavigateCell={handleNavigateCell}
          onEscapeToGrid={handleEscapeToGrid}
          onGridRowKeyNav={handleGridRowKeyNav}
          getVoiceTakeCells={getVoiceTakeCells}
          getTokenForFile={getTokenForFile}
          getAlignmentModel={getAlignmentModel}
          onAlignmentSeedChange={onAlignmentSeedChange}
          sourceFontSize={sourceFontSize}
          targetFontSize={targetFontSize}
          assigneeLabel={assignmentsByCellId?.get(cell.id)?.username ?? null}
          assigneeNote={assignmentsByCellId?.get(cell.id)?.scopeLabel ?? null}
          checkLockHolder={checkLockHolder}
          showFootnotesInline={showFootnotesInline}
          footnotePanelActive={footnotePanelActive}
          footnoteViewMode={footnoteViewMode}
          onFootnoteHoverChange={setHoveredFootnote}
          onFootnoteCreated={onFootnoteCreated}
          sourceFootnoteNumberOffset={footnoteNumberOffsets.get(cell.id)?.source ?? 0}
          targetFootnoteNumberOffset={footnoteNumberOffsets.get(cell.id)?.target ?? 0}
        />
      </div>
    )
  }, [
    activeCueIndex,
    activeEditorCellId,
    assignmentsByCellId,
    audioLens,
    backtranslating,
    backtranslationErrors,
    canEdit,
    canValidate,
    cellLockHolders,
    cellOpenCommentCount,
    cellsWithRemoteChange,
    checkLockHolder,
    completing,
    errors,
    examples,
    footnoteNumberOffsets,
    footnotePanelActive,
    footnoteViewMode,
    getTokenForFile,
    getAlignmentModel,
    getVoiceTakeCells,
    gridCols,
    handleDragEnter,
    handleDragStart,
    handleActivateEditor,
    handleDeactivateEditor,
    handleEscapeToGrid,
    handleGridRowKeyNav,
    handleNavigateCell,
    handleSelectionPointerDown,
    healthMap,
    infractions,
    isAnonymous,
    isBacktranslationConfigured,
    isCompletionAvailable,
    isCompletionConfigured,
    isTimeOrdered,
    lineNumbersEnabled,
    micDenied,
    onAckRemoteChange,
    onAddConceptFromSelection,
    onAlignmentSeedChange,
    onAskAiFromSelection,
    onBacktranslate,
    onCellCommitted,
    onClaimCell,
    onCompleteSingle,
    onFootnoteCreated,
    onJumpToCell,
    onOpenAudioSetup,
    onOptimisticEdit,
    onProjectChanged,
    onReleaseCell,
    onSaveBacktranslation,
    onSeekToCue,
    onAssignVoice,
    previews,
    project,
    ruleMap,
    showFootnotesInline,
    sourceFontSize,
    sourceTextDirection,
    staleCellIds,
    targetFontSize,
    targetTextDirection,
    username,
  ])

  return (
    <div className="flex h-full min-h-0 flex-col" onMouseUp={handleMouseUp}>
      <div className="shrink-0 bg-background">
        {/* FRO-250: sticky section/chapter indicator strip. Appears above the
            column header when the file has section-tagged cells. Keeps the
            reader oriented while scrolling through long Bible chapters. */}
        {currentSectionLabel && !looksLikeUuid(currentSectionLabel) && (
          <div className="flex items-center gap-1.5 border-b border-border/40 px-4 py-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {currentSectionLabel}
            </span>
          </div>
        )}
        {/* FRO-273: role badge — shown for read-only roles (viewer/commenter/reviewer) */}
        {readOnlyLabel && (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-shrink-0"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            {readOnlyLabel}
          </div>
        )}
        <div className={cn("grid gap-2 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground", gridCols)}>
          <div />
          {/* In Audio mode the left column carries per-line voice controls, not
              source text, so label it "Controls" (no source-language badge). */}
          <div className="flex items-center gap-2">
            {audioLens ? "Controls" : "Source"}
            {!audioLens && project.sourceLanguage && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                {project.sourceLanguage}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 pl-3">
            Target
            {project.targetLanguage && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                {project.targetLanguage}
              </span>
            )}
          </div>
        </div>
      </div>

      {displayCells.length > 0 ? (
        <div ref={listRootRef} className="flex min-h-0 flex-1">
          <LegendList
            ref={listRef}
            refScrollView={setListScrollElement}
            data={displayCells}
            renderItem={renderListItem}
            extraData={renderListItem}
            keyExtractor={(cell) => cell.id}
            estimatedItemSize={ESTIMATED_ROW_HEIGHT_PX}
            drawDistance={LEGEND_LIST_DRAW_DISTANCE_PX}
            recycleItems
            maintainVisibleContentPosition
            onFirstVisibleItemChanged={handleFirstVisibleItemChanged}
            onViewableItemsChanged={handleViewableItemsChanged}
            viewabilityConfig={{ viewAreaCoveragePercentThreshold: 0 }}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ width: "100%" }}
          />
        </div>
      ) : isTimeOrdered ? (
        audioLens && canEdit && onAttachMediaFile && onAttachMediaUrl ? (
          <div className="flex-1">
            <TimelineAddMedia onAttachFile={onAttachMediaFile} onAttachUrl={onAttachMediaUrl} />
          </div>
        ) : (
          <div className="flex-1 px-4 py-10 text-center text-sm text-muted-foreground">
            {audioLens
              ? "No media segments yet. Import an audio or video file, or record a take, to populate the media layer."
              : "No text segments in this file."}
          </div>
        )
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
})

/**
 * Memoized row wrapper. Owns every per-cell derivation that used to live in
 * the parent render loop — `examples.get(id) ?? []` style lookups, the
 * `isActiveCue`/`hasOpenComments` booleans, the drag handler binding to
 * cell.id. Moving them here lets React.memo actually hold: when typing in
 * cell X rebuilds only X's CellData (per the useCells cache), rows for every
 * OTHER cell receive the same `cell` ref, same stable maps, same stable
 * callbacks — memo hits and they skip render entirely.
 *
 * The parent (EditorTable) still re-renders per keystroke; this wrapper is
 * the cutoff point where the re-render tree gets pruned.
 */
interface MemoizedRowProps {
  project: ProjectRecord
  cell: CellData
  isEditorActive: boolean
  onActivateEditor: (cellId: string) => void
  onDeactivateEditor: (cellId: string) => void
  username: string
  editable: boolean
  /** FRO-273: reviewer (300) can validate but not edit. True whenever role ≥ REVIEWER. */
  canValidate: boolean
  /** Phase 5 / AD-9: source has advanced since this target was last committed.
   *  Resolved once per file by the parent (membership look-up) so this prop
   *  is just a stable boolean — preserves the row's React.memo invariant. */
  isStaleSource: boolean
  onCellCommitted?: (cellId: string, committedEventId?: string) => void | Promise<void>
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  lockHolderLabel: string | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  examples: Map<string, ScoredPair[]>
  completing: Map<string, string>
  errors: Map<string, string>
  previews: Map<string, string>
  healthMap: Map<string, number>
  infractions: Map<string, RuleInfraction[]>
  ruleMap: Map<string, TranslationRule>
  onCompleteSingle: (cell: CellData) => void
  isBacktranslationConfigured?: boolean
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  onBacktranslate?: (cell: CellData, polish?: boolean) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  cellOpenCommentCount?: Map<string, number>
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  /** Add-from-selection: create a DRAFT concept from a selected source token. */
  onAddConceptFromSelection?: (sourceTerm: string) => void | Promise<void>
  onAskAiFromSelection?: (chip: ContextChip) => void
  onAssignVoice?: (cellId: string, voiceId: string) => void
  onDragStart: (cellId: string) => void
  onDragEnter: (cellId: string) => void
  onSelectionPointerDown: (
    cellId: string,
    rowIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => void
  onNavigateCell: (cellId: string, direction: "prev" | "next") => void
  /** FRO-297: Called when Esc is pressed inside a cell editor — returns focus to the grid row. */
  onEscapeToGrid: (cellId: string) => void
  /** FRO-297: Arrow-key navigation while grid-row (not TipTap) is focused. */
  onGridRowKeyNav: (cellId: string, direction: "prev" | "next") => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** FRO-207: Lazily returns the interlinear alignment model. */
  getAlignmentModel?: () => import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when user confirms/invalidates an alignment. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
  /** FRO-251: per-file source-column font size in px. Defaults to 14 when absent. */
  sourceFontSize?: number
  /** FRO-251: per-file target-column font size in px. Defaults to 14 when absent. */
  targetFontSize?: number
  /** FRO-192: username of the assignee for this cell. Null = no assignment. */
  assigneeLabel?: string | null
  /** FRO-192: scope label for the assignment tooltip. */
  assigneeNote?: string | null
  /** RACE-5: ref-backed live lock check — see EditorTableProps.checkLockHolder. */
  checkLockHolder?: (cellId: string) => string | null
  /** FRO-317: when true, USFM \f...\f* footnotes render below each cell. */
  showFootnotesInline?: boolean
  /** True when inline/tray footnote detail is already visible elsewhere. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** Reports the target footnote currently hovered in this row. */
  onFootnoteHoverChange?: (hovered: { cellId: string; index: number } | null) => void
  /** Called after a target footnote is created. */
  onFootnoteCreated?: () => void
  sourceFootnoteNumberOffset: number
  targetFootnoteNumberOffset: number
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, previews, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount,
    activeCueIndex, rowIndex, gridCols,
    onDragStart: onDragStartParent, onDragEnter: onDragEnterParent,
    onSelectionPointerDown: onSelectionPointerDownParent,
    onNavigateCell: onNavigateCellParent,
    onEscapeToGrid: onEscapeToGridParent,
    onGridRowKeyNav: onGridRowKeyNavParent,
    getVoiceTakeCells,
    getTokenForFile,
    getAlignmentModel,
    onAlignmentSeedChange,
    sourceFontSize,
    targetFontSize,
    isEditorActive,
    onActivateEditor,
    onDeactivateEditor,
    project, username, editable, canValidate, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle,
    isBacktranslationConfigured, onBacktranslate, onSaveBacktranslation,
    onSeekToCue, lineNumbersEnabled, cellLabelsEnabled,
    sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, micDenied, onProjectChanged, onAddConceptFromSelection, onAskAiFromSelection, onAssignVoice,
    audioLens, onOpenAudioSetup,
    onCellCommitted, onOptimisticEdit, lockHolderLabel, remoteChangedWhileFocused,
    onClaimCell, onReleaseCell, onAckRemoteChange,
    isStaleSource,
    assigneeLabel,
    assigneeNote,
    checkLockHolder,
    showFootnotesInline,
    footnotePanelActive,
    footnoteViewMode = "off",
    onFootnoteHoverChange,
    onFootnoteCreated,
    sourceFootnoteNumberOffset,
    targetFootnoteNumberOffset,
  } = props

  const cellId = cell.id
  if (isPerfLogEnabled()) {
    const key = cellId.slice(0, 8)
    rowRenders.set(key, (rowRenders.get(key) ?? 0) + 1)
  }
  const cellExamples = useMemo(() => examples.get(cellId) ?? EMPTY_EXAMPLES, [examples, cellId])
  const highlights = useMemo(() => buildHighlightsFromExamples(cellExamples), [cellExamples])
  const cellInfractions = useMemo(() => infractions.get(cellId) ?? EMPTY_INFRACTIONS, [infractions, cellId])

  const { active: activeInfractions, waived: waivedInfractions } = useMemo(
    () => partitionInfractions(cellInfractions, cell.waivers),
    [cellInfractions, cell.waivers],
  )

  const completingState = completing.get(cellId)
  const isLoading = completingState === "searching" || completingState === "generating"
  // Streaming preview text — populated chunk-by-chunk by useCompletion's
  // onChunk handler. We surface it in the target column so the user sees
  // tokens arrive in real time instead of waiting for the LLM to finish
  // AND the commit-to-outbox chain to land (which adds a network hop).
  const completionPreview = previews.get(cellId)
  const loadingPhase: "searching" | "generating" | null =
    completingState === "searching"
      ? "searching"
      : completingState === "generating"
        ? "generating"
        : null
  const error = errors.get(cellId)
  const health = healthMap.get(cellId)
  const isBacktranslating = backtranslating?.has(cellId)
  const backtranslationError = backtranslationErrors?.get(cellId)
  const openCommentCount = cellOpenCommentCount?.get(cellId) ?? 0
  const isActiveCue = activeCueIndex !== undefined && activeCueIndex === rowIndex

  // Bind the stable parent (cellId) => void handlers to this row's cellId.
  // Stable per-row because both parent callbacks and cellId are stable.
  const handleDragStart = useCallback(() => onDragStartParent(cellId), [onDragStartParent, cellId])
  const handleDragEnter = useCallback(() => onDragEnterParent(cellId), [onDragEnterParent, cellId])
  const handleSelectionPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => onSelectionPointerDownParent(cellId, rowIndex, e),
    [onSelectionPointerDownParent, cellId, rowIndex],
  )
  const handleNavigateCell = useCallback(
    (direction: "prev" | "next") => onNavigateCellParent(cellId, direction),
    [onNavigateCellParent, cellId],
  )
  const handleEscapeToGrid = useCallback(
    () => onEscapeToGridParent(cellId),
    [onEscapeToGridParent, cellId],
  )
  const handleGridRowKeyNav = useCallback(
    (direction: "prev" | "next") => onGridRowKeyNavParent(cellId, direction),
    [onGridRowKeyNavParent, cellId],
  )

  return (
    <div
      className={cn(
        // Outer wrapper is the list item's measured spacer. Rows are now a
        // flush, continuous list (Linear flat model), so there's no inset/gap
        // here — the row's own px-4 and its border-b divider do the work.
        // (Margins here would interfere with dynamic row measurement.)
      )}
    >
      <EditorRow
        project={project}
        cell={cell}
        isEditorActive={isEditorActive}
        onActivateEditor={onActivateEditor}
        onDeactivateEditor={onDeactivateEditor}
        username={username}
        editable={editable}
        canValidate={canValidate}
        isStaleSource={isStaleSource}
        isCompletionConfigured={isCompletionConfigured}
        isCompletionAvailable={isCompletionAvailable}
        isLoading={isLoading}
        completionPreview={completionPreview}
        loadingPhase={loadingPhase}
        cellExamples={cellExamples}
        highlights={highlights}
        error={error}
        health={health}
        cellInfractions={activeInfractions}
        waivedInfractions={waivedInfractions}
        ruleMap={ruleMap}
        onCompleteSingle={onCompleteSingle}
        isBacktranslationConfigured={isBacktranslationConfigured}
        isBacktranslating={isBacktranslating}
        backtranslationError={backtranslationError}
        onBacktranslate={onBacktranslate}
        onSaveBacktranslation={onSaveBacktranslation}
        openCommentCount={openCommentCount}
        isActiveCue={isActiveCue}
        onSeekToCue={onSeekToCue}
        rowIndex={rowIndex}
        lineNumbersEnabled={lineNumbersEnabled}
        cellLabelsEnabled={cellLabelsEnabled}
        sourceTextDirection={sourceTextDirection}
        targetTextDirection={targetTextDirection}
        gridCols={gridCols}
        isAnonymous={isAnonymous}
        onJumpToCell={onJumpToCell}
        micDenied={micDenied}
        audioLens={audioLens}
        onOpenAudioSetup={onOpenAudioSetup}
        onProjectChanged={onProjectChanged}
        onAddConceptFromSelection={onAddConceptFromSelection}
        onAskAiFromSelection={onAskAiFromSelection}
        onAssignVoice={onAssignVoice}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onSelectionPointerDown={handleSelectionPointerDown}
        onNavigateCell={handleNavigateCell}
        onEscapeToGrid={handleEscapeToGrid}
        onGridRowKeyNav={handleGridRowKeyNav}
        getVoiceTakeCells={getVoiceTakeCells}
        getTokenForFile={getTokenForFile}
        getAlignmentModel={getAlignmentModel}
        onAlignmentSeedChange={onAlignmentSeedChange}
        onCellCommitted={onCellCommitted}
        onOptimisticEdit={onOptimisticEdit}
        lockHolderLabel={lockHolderLabel}
        remoteChangedWhileFocused={remoteChangedWhileFocused}
        onClaimCell={onClaimCell}
        onReleaseCell={onReleaseCell}
        onAckRemoteChange={onAckRemoteChange}
        sourceFontSize={sourceFontSize}
        targetFontSize={targetFontSize}
        assigneeLabel={assigneeLabel}
        assigneeNote={assigneeNote}
        checkLockHolder={checkLockHolder}
        showFootnotesInline={showFootnotesInline}
        footnotePanelActive={footnotePanelActive}
        footnoteViewMode={footnoteViewMode}
        onFootnoteHoverChange={onFootnoteHoverChange}
        onFootnoteCreated={onFootnoteCreated}
        sourceFootnoteNumberOffset={sourceFootnoteNumberOffset}
        targetFootnoteNumberOffset={targetFootnoteNumberOffset}
      />
    </div>
  )
})

interface EditorRowProps {
  project: ProjectRecord
  cell: CellData
  isEditorActive: boolean
  onActivateEditor: (cellId: string) => void
  onDeactivateEditor: (cellId: string) => void
  username: string
  editable: boolean
  /** FRO-273: reviewer (300) can validate but not edit. True whenever role ≥ REVIEWER. */
  canValidate: boolean
  /** Phase 5 / AD-9 — true when the source has advanced since the last
   *  target commit. Renders a small warning badge next to the validation
   *  status. Computed once-per-file by the parent. */
  isStaleSource: boolean
  onCellCommitted?: (cellId: string, committedEventId?: string) => void
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  lockHolderLabel: string | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onAckRemoteChange?: (cellId: string) => void
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  isLoading: boolean
  /** Streaming completion text for this cell, while `isLoading` is true.
   *  Undefined when no completion is in flight. Empty string is possible
   *  in the brief window between "searching" and the first token. */
  completionPreview: string | undefined
  /** Which phase of the completion is currently running, if any. Drives the
   *  placeholder copy ("Looking up examples…" vs "Generating…"). */
  loadingPhase: "searching" | "generating" | null
  cellExamples: ScoredPair[]
  highlights: ReturnType<typeof buildHighlightsFromExamples>
  error?: string
  health: number | undefined
  cellInfractions: RuleInfraction[]
  waivedInfractions: RuleInfraction[]
  ruleMap: Map<string, TranslationRule>
  onCompleteSingle: (cell: CellData) => void
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  onBacktranslate?: (cell: CellData, polish?: boolean) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  /** FRO-207: Lazily returns the interlinear alignment model. */
  getAlignmentModel?: () => import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when user confirms/invalidates an alignment. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
  openCommentCount: number
  isActiveCue?: boolean
  onSeekToCue?: (cellId: string) => void
  onDragStart: () => void
  onDragEnter: () => void
  onSelectionPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
  onNavigateCell: (direction: "prev" | "next") => void
  /** FRO-297: Esc inside TipTap — commit + return focus to the grid row wrapper. */
  onEscapeToGrid: () => void
  /** FRO-297: Arrow/j/k navigation while grid row wrapper is focused (not TipTap). */
  onGridRowKeyNav: (direction: "prev" | "next") => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  /** Add-from-selection: create a DRAFT concept from a selected source token. */
  onAddConceptFromSelection?: (sourceTerm: string) => void | Promise<void>
  onAskAiFromSelection?: (chip: ContextChip) => void
  onAssignVoice?: (cellId: string, voiceId: string) => void
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** FRO-251: per-file source-column font size in px. Defaults to 14 when absent. */
  sourceFontSize?: number
  /** FRO-251: per-file target-column font size in px. Defaults to 14 when absent. */
  targetFontSize?: number
  /** FRO-192: username of the assignee for this cell. Null = no assignment. */
  assigneeLabel?: string | null
  /** FRO-192: scope label for the assignment tooltip. */
  assigneeNote?: string | null
  /** RACE-5: ref-backed live lock check — see EditorTableProps.checkLockHolder. */
  checkLockHolder?: (cellId: string) => string | null
  /** FRO-317: when true, USFM \f...\f* footnotes render below the cell row. */
  showFootnotesInline?: boolean
  /** True when inline/tray footnote detail is already visible elsewhere. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** Reports the target footnote currently hovered in this row. */
  onFootnoteHoverChange?: (hovered: { cellId: string; index: number } | null) => void
  /** Called after a target footnote is created. */
  onFootnoteCreated?: () => void
  sourceFootnoteNumberOffset: number
  targetFootnoteNumberOffset: number
}

// SelectionTermActions was replaced by SourceSelectionToolbar (./SourceSelectionToolbar),
// which adds an "Ask AI" action and matches the editor hover-rail aesthetic.

// ────────────────────────────────────────────────────────────────────────────
// SourceWithTermLookup — renders source plain text with per-word
// TermLookupPopover triggers for any word that matches an active concept.
// Words that have no matching concept render as plain text (no popover cost).
// When no concepts are configured the component falls back to a plain
// HighlightedText so there's zero overhead on projects that don't use
// the terminology feature.
// ────────────────────────────────────────────────────────────────────────────

interface SourceWithTermLookupProps {
  text: string
  highlights: ReturnType<typeof buildHighlightsFromExamples>
  ranges: RangeHighlight[]
  showEvidence: boolean
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
  concepts: Concept[]
  onTermApply: (rendering: string) => void
  /** Render as an inline span (used per-segment by UsfmSourceText). */
  inline?: boolean
  /** When true, note chips stay markers because detail is shown in a panel. */
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
}

function SourceWithTermLookup({
  text,
  highlights,
  ranges,
  showEvidence,
  onRangeClick,
  concepts,
  onTermApply,
  inline = false,
}: SourceWithTermLookupProps) {
  // All hooks must run unconditionally before any early return.
  const activeConcepts = useMemo(
    () => concepts.filter((c) => c.status === "active"),
    [concepts],
  )

  // Build a normalized concept index keyed by lowercased sourceTerm for O(1)
  // per-word lookup. We do exact-word match (normalized, case-insensitive)
  // per the task spec: "normalized, case-insensitive match against
  // concept.sourceTerm". Both the raw lowercase and a punctuation-stripped
  // form are checked so "God," and "God" both resolve.
  const conceptIndex = useMemo(() => {
    const idx = new Map<string, Concept[]>()
    for (const c of activeConcepts) {
      const key = c.sourceTerm.toLowerCase()
      const existing = idx.get(key)
      if (existing) existing.push(c)
      else idx.set(key, [c])
    }
    return idx
  }, [activeConcepts])

  // Tokenize the source text into words + inter-word whitespace segments.
  const tokens = useMemo(() => tokenizeWords(text), [text])

  // Fast path: no active concepts → plain HighlightedText, zero popover cost.
  // Font size inherits from the source column wrapper (per-file pref) — no
  // fixed text-* class here.
  if (activeConcepts.length === 0) {
    const Wrapper = inline ? "span" : "div"
    return (
      <Wrapper>
        <HighlightedText
          text={text}
          highlights={highlights}
          ranges={ranges}
          showEvidence={showEvidence}
          onRangeClick={onRangeClick}
        />
      </Wrapper>
    )
  }

  // Build the inline spans: whitespace gaps between tokens are plain text;
  // tokens are wrapped with TermLookupPopover when they match a concept.
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < tokens.length; i++) {
    const { word, start, end } = tokens[i]
    // Whitespace between previous token and this one.
    if (start > cursor) {
      parts.push(<React.Fragment key={`ws-${i}`}>{text.slice(cursor, start)}</React.Fragment>)
    }
    // Check raw lowercase and punctuation-stripped form so "God," → "god" matches "God".
    const normalizedWord = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
    const matchedConcepts = conceptIndex.get(word.toLowerCase()) ?? conceptIndex.get(normalizedWord)
    if (matchedConcepts && matchedConcepts.length > 0) {
      parts.push(
        <TermLookupPopover
          key={`term-${i}`}
          sourceTerm={word}
          concepts={activeConcepts}
          onApply={onTermApply}
        >
          <span className="cursor-pointer underline decoration-dotted decoration-primary/60 underline-offset-2 hover:decoration-primary">
            {word}
          </span>
        </TermLookupPopover>,
      )
    } else {
      parts.push(<React.Fragment key={`w-${i}`}>{word}</React.Fragment>)
    }
    cursor = end
  }
  // Trailing whitespace after last token.
  if (cursor < text.length) {
    parts.push(<React.Fragment key="ws-tail">{text.slice(cursor)}</React.Fragment>)
  }

  const Wrapper = inline ? "span" : "div"
  return (
    <Wrapper>
      {parts}
    </Wrapper>
  )
}

// ---------------------------------------------------------------------------
// USFM display rendering (FRO-317 follow-up)
// ---------------------------------------------------------------------------
// Cell text stores intra-verse USFM markers verbatim (lossless round-trip),
// but the editor must never show raw `\f + \fr 2:1 \ft …\f*` / `\w …\w*` to a
// translator. UsfmSourceText segments the raw text for display: character
// markers are unwrapped, structural markers become line breaks, and notes
// (footnotes/endnotes/crossrefs) collapse into superscript chips that open a
// popover. The stored value is untouched — violation ranges are clipped from
// raw-text offsets into each segment via clipRangesToSegment.

function UsfmNoteChip({
  note,
  ordinal,
  panelActive,
}: {
  note: UsfmNoteSegment
  ordinal: number
  panelActive?: boolean
}) {
  const label =
    note.noteKind === "xref" ? "†" : note.caller && note.caller !== "+" && note.caller !== "-" ? note.caller : String(ordinal)
  const kindLabel = note.noteKind === "xref" ? "Cross reference" : note.noteKind === "endnote" ? "Endnote" : "Footnote"
  const tooltipContent = (
    <div className="max-w-72 text-xs">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{kindLabel}</span>
        {note.ref && <span className="font-mono text-[10px] text-muted-foreground">{note.ref}</span>}
      </div>
      <div>{note.text || <span className="italic text-muted-foreground">(empty)</span>}</div>
    </div>
  )
  const chip = (
    <button
      type="button"
      className={cn(
        "mx-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted px-0.5 align-super text-[9px] font-bold leading-none text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary focus-visible:bg-primary/15 focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
        panelActive ? "cursor-default" : "cursor-help",
      )}
      aria-label={`${kindLabel}${note.ref ? ` ${note.ref}` : ""}`}
    >
      {label}
    </button>
  )

  return (
    <AppTooltip content={tooltipContent} side="bottom">
      {chip}
    </AppTooltip>
  )
}

function defaultFootnoteRef(cell: CellData): string {
  const candidates = [
    ...(cell.globalReferences ?? []),
    cell.group,
    cell.context,
    cell.cellLabel,
  ].filter(Boolean)

  for (const candidate of candidates) {
    const text = String(candidate).trim()
    const canonicalRef = text.match(/\b[1-3]?\s?[A-Z][A-Z0-9]{1,4}\s+\d+:\d+(?:[-–]\d+)?\b/i)
    if (canonicalRef) return canonicalRef[0].replace(/\s+/g, " ")
  }

  for (const candidate of candidates) {
    const text = String(candidate).trim()
    const verseOnlyRef = text.match(/\b\d+:\d+(?:[-–]\d+)?\b/)
    if (verseOnlyRef) return verseOnlyRef[0]
  }

  return ""
}

function footnoteScopeKey(cell: CellData): string {
  const candidates = [
    ...(cell.globalReferences ?? []),
    cell.group,
    cell.context,
    cell.cellLabel,
  ].filter(Boolean)

  for (const candidate of candidates) {
    const parsed = parseFootnoteChapterScope(String(candidate))
    if (parsed) return `${cell.fileId}:${parsed}`
  }

  return `${cell.fileId}:${cell.section || cell.context || "__file__"}`
}

function humanFootnoteCellRef(cell: CellData): string {
  const value = (cell.group || cell.context || "").trim()
  if (!value || looksLikeUuid(value)) return ""
  return value
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

function footnoteMarkerOptions(
  cell: CellData,
  anchor: FootnoteInsertionAnchor | null,
  numberOffset: number,
): Record<FootnoteMarkerStyle, AddFootnoteMarkerOption> {
  const targetFootnotes = extractUsfmFootnotes(cell.translated ?? "")
  const insertionIndex = anchor?.plainPosition ?? Number.POSITIVE_INFINITY
  const targetFootnotesBeforeInsertion = targetFootnotes.filter((footnote) => footnote.index < insertionIndex)
  const numberedPreview = numberOffset + targetFootnotesBeforeInsertion.length + 1
  const letterCallers = targetFootnotes
    .map((footnote) => footnote.caller.trim().toLowerCase())
    .filter((caller) => /^[a-z]+$/.test(caller))
  const nextLetter = nextFootnoteLetter(letterCallers)

  return {
    numbered: {
      label: "Numbering",
      caller: "+",
      startCaller: "1",
      preview: String(numberedPreview),
      startPreview: "1",
      description: "Use automatic numeric markers.",
    },
    lettered: {
      label: "Lettering",
      caller: nextLetter,
      startCaller: "a",
      preview: nextLetter,
      startPreview: "a",
      description: "Use letter markers for a separate note sequence.",
    },
  }
}

function footnoteMarkerStyleFromCaller(caller: string | undefined): FootnoteMarkerStyle {
  const trimmed = caller?.trim().toLowerCase() ?? ""
  return /^[a-z]+$/.test(trimmed) ? "lettered" : "numbered"
}

function nextFootnoteLetter(existingLetters: string[]): string {
  let max = 0
  for (const letter of existingLetters) {
    max = Math.max(max, letterToNumber(letter))
  }
  return numberToLetter(max + 1)
}

function letterToNumber(value: string): number {
  let total = 0
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 97 || code > 122) continue
    total = total * 26 + (code - 96)
  }
  return total
}

function numberToLetter(value: number): string {
  let current = Math.max(1, value)
  let output = ""
  while (current > 0) {
    current -= 1
    output = String.fromCharCode(97 + (current % 26)) + output
    current = Math.floor(current / 26)
  }
  return output
}

function footnoteAnchorText(anchor: FootnoteInsertionAnchor | null): string {
  if (!anchor) return ""
  if (anchor.source === "selection" || anchor.source === "word") {
    return anchor.previewText ?? ""
  }
  return lastVisibleWordBeforeFootnote(anchor.previewBefore ?? "")
}

const FOOTNOTE_ANCHOR_RE = /\\f\s+[^\s\\]+[\s\S]*?\\f\*/g

function lastVisibleWordBeforeFootnote(value: string): string {
  const visible = value
    .replace(FOOTNOTE_ANCHOR_RE, "")
    .replace(/\\[a-z0-9*]+/gi, " ")
    .trim()
  const match = visible.match(/([\p{L}\p{N}][\p{L}\p{N}'’-]*)[^\p{L}\p{N}]*$/u)
  return match?.[1] ?? ""
}

function UsfmSourceText(props: SourceWithTermLookupProps) {
  const segments = useMemo(() => segmentUsfmForDisplay(props.text), [props.text])

  // Fast path: no USFM markers in this cell — render exactly as before.
  if (segments === null) return <SourceWithTermLookup {...props} />

  let ordinal = props.footnoteNumberOffset ?? 0
  const parts: React.ReactNode[] = []
  segments.forEach((seg, i) => {
    if (seg.kind === "break") {
      // Suppress a break before any visible content (e.g. text starting "\p ").
      if (parts.length === 0) return
      parts.push(<br key={`br-${i}`} />)
      if (seg.blank) parts.push(<br key={`br2-${i}`} />)
      if (seg.indent > 0) {
        parts.push(
          <span key={`in-${i}`} aria-hidden className="inline-block" style={{ width: `${seg.indent}em` }} />,
        )
      }
      return
    }
    if (seg.kind === "note") {
      ordinal += 1
      parts.push(
        <UsfmNoteChip
          key={`note-${i}`}
          note={seg}
          ordinal={ordinal}
          panelActive={props.footnotePanelActive}
        />,
      )
      return
    }
    parts.push(
      <SourceWithTermLookup
        key={`t-${i}`}
        {...props}
        inline
        text={seg.text}
        ranges={clipRangesToSegment(props.ranges, seg)}
      />,
    )
  })

  return <div>{parts}</div>
}

function SanitizedRichHtml({ html }: { html: string }) {
  const safeHtml = useMemo(() => DOMPurify.sanitize(html), [html])
  const innerHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])

  return (
    <div
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={innerHtml}
    />
  )
}

function TargetRichHtml({
  html,
  footnotePanelActive,
  footnoteNumberOffset = 0,
}: {
  html: string
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
}) {
  const safeHtml = useMemo(
    () => prepareReadOnlyRichTextHtml(html, {
      footnoteNumberOffset,
      showFootnoteTooltips: !footnotePanelActive,
    }),
    [footnoteNumberOffset, footnotePanelActive, html],
  )
  const innerHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])

  return (
    <div
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={innerHtml}
    />
  )
}

function TargetReadText({
  text,
  ranges,
  concepts,
  onRangeClick,
  onTermChipClick,
  footnotePanelActive,
  footnoteNumberOffset = 0,
}: {
  text: string
  ranges: RangeHighlight[]
  concepts: Concept[]
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
  onTermChipClick?: (term: string, anchor: HTMLElement) => void
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
}) {
  const segments = useMemo(() => segmentUsfmForDisplay(text), [text])

  if (segments === null) {
    return (
      <TargetDecoratedText
        text={text}
        concepts={concepts}
        ranges={ranges}
        onRangeClick={onRangeClick}
        onTermChipClick={onTermChipClick}
      />
    )
  }

  let ordinal = footnoteNumberOffset
  const parts: React.ReactNode[] = []
  segments.forEach((seg, i) => {
    if (seg.kind === "break") {
      if (parts.length === 0) return
      parts.push(<br key={`br-${i}`} />)
      if (seg.blank) parts.push(<br key={`br2-${i}`} />)
      if (seg.indent > 0) {
        parts.push(
          <span key={`in-${i}`} aria-hidden className="inline-block" style={{ width: `${seg.indent}em` }} />,
        )
      }
      return
    }
    if (seg.kind === "note") {
      ordinal += 1
      parts.push(
        <UsfmNoteChip
          key={`note-${i}`}
          note={seg}
          ordinal={ordinal}
          panelActive={footnotePanelActive}
        />,
      )
      return
    }
    parts.push(
      <TargetDecoratedText
        key={`t-${i}`}
        text={seg.text}
        concepts={concepts}
        ranges={clipRangesToSegment(ranges, seg)}
        onRangeClick={onRangeClick}
        onTermChipClick={onTermChipClick}
      />,
    )
  })

  return <div>{parts}</div>
}

function TargetDecoratedText({
  text,
  concepts,
  ranges,
  onRangeClick,
  onTermChipClick,
}: {
  text: string
  concepts: Concept[]
  ranges: RangeHighlight[]
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
  onTermChipClick?: (term: string, anchor: HTMLElement) => void
}) {
  const matches = useMemo(() => {
    const activeConcepts = concepts.filter((concept) => concept.status === "active")
    if (activeConcepts.length === 0 || !text) return []

    const out: Array<{ start: number; end: number; term: string }> = []
    for (const concept of activeConcepts) {
      for (const match of findTermMatches(text, concept.sourceTerm)) {
        out.push({ ...match, term: concept.sourceTerm })
      }
    }
    out.sort((a, b) => a.start - b.start || b.end - a.end)

    const nonOverlapping: Array<{ start: number; end: number; term: string }> = []
    let cursor = 0
    for (const match of out) {
      if (match.start < cursor) continue
      nonOverlapping.push(match)
      cursor = match.end
    }
    return nonOverlapping
  }, [concepts, text])

  if (matches.length === 0) {
    return (
      <HighlightedText
        text={text}
        highlights={EMPTY_HIGHLIGHTS}
        ranges={ranges}
        showEvidence={false}
        onRangeClick={onRangeClick}
      />
    )
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  matches.forEach((match, index) => {
    if (match.start > cursor) {
      const before = text.slice(cursor, match.start)
      parts.push(
        <HighlightedText
          key={`t-${index}-before`}
          text={before}
          highlights={EMPTY_HIGHLIGHTS}
          ranges={clipRangesToTextSlice(ranges, cursor, match.start)}
          showEvidence={false}
          onRangeClick={onRangeClick}
        />,
      )
    }

    const matchedText = text.slice(match.start, match.end)
    parts.push(
      <span key={`t-${index}-term`} className="term-chip-host" data-source-term={match.term}>
        <HighlightedText
          text={matchedText}
          highlights={EMPTY_HIGHLIGHTS}
          ranges={clipRangesToTextSlice(ranges, match.start, match.end)}
          showEvidence={false}
          onRangeClick={onRangeClick}
        />
        <span
          role={onTermChipClick ? "button" : undefined}
          tabIndex={onTermChipClick ? 0 : undefined}
          aria-label={`Managed term: ${match.term}`}
          title={`Managed term: ${match.term}`}
          data-source-term={match.term}
          className="term-chip term-chip-preferred"
          onClick={onTermChipClick ? (event) => {
            event.stopPropagation()
            onTermChipClick(match.term, event.currentTarget)
          } : undefined}
          onKeyDown={onTermChipClick ? (event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            event.stopPropagation()
            onTermChipClick(match.term, event.currentTarget)
          } : undefined}
        />
      </span>,
    )
    cursor = match.end
  })

  if (cursor < text.length) {
    parts.push(
      <HighlightedText
        key="t-tail"
        text={text.slice(cursor)}
        highlights={EMPTY_HIGHLIGHTS}
        ranges={clipRangesToTextSlice(ranges, cursor, text.length)}
        showEvidence={false}
        onRangeClick={onRangeClick}
      />,
    )
  }

  return <span>{parts}</span>
}

function clipRangesToTextSlice(
  ranges: readonly RangeHighlight[],
  sliceStart: number,
  sliceEnd: number,
): RangeHighlight[] {
  const out: RangeHighlight[] = []
  for (const range of ranges) {
    const start = Math.max(range.start, sliceStart)
    const end = Math.min(range.end, sliceEnd)
    if (start < end) {
      out.push({ ...range, start: start - sliceStart, end: end - sliceStart })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// SourceReferenceAttachments — read-only source-side reference media (OBS frame
// images, etc.) drawn from the extensible `cell.metadata.attachments` bucket.
// Renders ABOVE the source text; it is reference context only and is NOT part
// of the editable target. Cheap conditional JSX (no effects/state) so the
// virtualized row stays light.
// ---------------------------------------------------------------------------
function SourceReferenceAttachments({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const attachments = (metadata as { attachments?: unknown } | null | undefined)?.attachments as
    | Array<{ type?: string; url?: string; alt?: string; title?: string }>
    | undefined
  if (!Array.isArray(attachments) || attachments.length === 0) return null

  const renderable = attachments.filter(
    (a) => a && typeof a.url === "string" && (a.type === "image" || a.type === "gif" || a.type === "video"),
  )
  if (renderable.length === 0) return null

  return (
    <div className="mb-2 flex flex-col gap-2" dir="ltr">
      {renderable.map((att, i) =>
        att.type === "video" ? (
          <video
            key={i}
            src={att.url}
            controls
            title={att.title}
            className="max-h-32 rounded border object-contain"
          />
        ) : (
          <img
            key={i}
            src={att.url}
            alt={att.alt}
            title={att.title}
            loading="lazy"
            className="block max-h-32 rounded border object-contain"
          />
        ),
      )}
    </div>
  )
}

function EditorRow({
  project, cell, isEditorActive, onActivateEditor, onDeactivateEditor,
  username, editable, canValidate, isCompletionConfigured, isCompletionAvailable, isLoading,
  completionPreview, loadingPhase,
  cellExamples, highlights, error, health,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate, onSaveBacktranslation,
  openCommentCount,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter, onSelectionPointerDown, onNavigateCell,
  onEscapeToGrid, onGridRowKeyNav,
  rowIndex, lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, micDenied,
  audioLens, onOpenAudioSetup, onAssignVoice, onAddConceptFromSelection, onAskAiFromSelection,
  onCellCommitted, onOptimisticEdit, lockHolderLabel, remoteChangedWhileFocused,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  isStaleSource,
  getTokenForFile,
  getAlignmentModel,
  onAlignmentSeedChange,
  sourceFontSize = 14,
  targetFontSize = 14,
  assigneeLabel,
  assigneeNote,
  checkLockHolder,
  showFootnotesInline,
  footnotePanelActive,
  footnoteViewMode = "off",
  onFootnoteHoverChange,
  onFootnoteCreated,
  sourceFootnoteNumberOffset,
  targetFootnoteNumberOffset,
}: EditorRowProps) {
  // FRO perf cleanup: pure pass-through openers (never consumed by
  // EditorTable/MemoizedRow) come from context instead of the prop chain —
  // keeps them out of MemoizedRow's React.memo compare surface.
  const { onInfractionClick, onOpenComments, onOpenHistory, onAiSetupNeeded, onOpenRecording } = useEditorActions()
  const hasTranslatedText = Boolean(cell.translated?.trim())
  const showCompletionOverlay = isLoading && !hasTranslatedText
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [openRuleAnchor, setOpenRuleAnchor] = useState<HTMLElement | null>(null)
  const [examplesExpanded, setExamplesExpanded] = useState(false)
  // FRO-204: chip click state for TermLookupPopover on target editor chips.
  const [termChipState, setTermChipState] = useState<{ term: string; anchor: HTMLElement } | null>(null)
  // Track whether the target editor has a non-empty text selection when a chip is clicked.
  const targetHasSelectionRef = useRef(false)
  // The exact selected target text captured at chip-click time, so Apply can
  // REPLACE that selection (spec 2c) rather than append. Cleared when no selection.
  const targetSelectionTextRef = useRef("")
  // Add-from-selection (Slice 5): the source-side text the user has selected,
  // surfaced as an "Add to termbase" affordance. Null when nothing selected.
  const [sourceSelection, setSourceSelection] = useState<string | null>(null)
  // FRO-260: ref mirror of sourceSelection so onClick handlers can read the
  // captured text even if a selectionchange event already cleared the React
  // state (the mousedown-before-click race that collapses the browser selection
  // before the click callback fires).
  const capturedSelectionRef = useRef<string | null>(null)
  // FRO-260: set to true while the user is pressing down on a SelectionTermActions
  // toolbar button, so the FRO-248 selectionchange guard doesn't clear
  // sourceSelection before onClick fires.
  const toolbarMouseDownRef = useRef(false)
  // Controls the confirm dialog shown before creating the draft concept.
  const [showAddConceptDialog, setShowAddConceptDialog] = useState(false)
  const pendingTargetEventIdRef = useRef<string | null>(cell.targetEventId ?? null)
  // RES-4: local error state for enqueue failures (IDB quota, role errors).
  // Surfaces a compact inline message below the editor instead of swallowing.
  /** voice-chip drag-over state: the voiceId being dragged over this cell's audio area */
  const [dragOverVoiceId, setDragOverVoiceId] = useState<string | null>(null)
  // FRO-237: mic-denied help popover state — rendered as an inline popover so
  // the rail button stays ENABLED when mic is blocked and routes click here.
  const [showMicDeniedHelp, setShowMicDeniedHelp] = useState(false)
  // FRO-274: write-failure banner state. Set when any outbox enqueue fails
  // (cell commit, validate, waive). The message persists until dismissed so
  // the user has time to copy their text before reloading.
  const [writeError, setWriteError] = useState<string | null>(null)
  // FRO-278: confirm dialog shown when Generate is triggered on a non-empty
  // cell. True = dialog is open; clicking Confirm calls onCompleteSingle,
  // clicking Cancel discards the pending action (nothing committed).
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const translatedEditorRef = useRef<TranslatedEditorHandle | null>(null)
  const pendingFootnoteAnchorRef = useRef<FootnoteInsertionAnchor | null>(null)
  const [activeFootnoteIndex, setActiveFootnoteIndex] = useState<number | null>(null)
  const [addFootnoteOpen, setAddFootnoteOpen] = useState(false)
  const [addFootnoteDefaults, setAddFootnoteDefaults] = useState<AddFootnoteDialogDefaults>({
    caller: "+",
    ref: "",
    text: "",
  })
  const allFootnotes = useMemo(() => ({
    sourceFootnotes: extractUsfmFootnotes(cell.original ?? ""),
    targetFootnotes: extractUsfmFootnotes(cell.translated ?? ""),
  }), [cell.original, cell.translated])
  const sourceDisplayFootnotes = useMemo(() => {
    const segments = segmentUsfmForDisplay(cell.original ?? "")
    if (!segments) return []
    return segments
      .filter((segment): segment is UsfmNoteSegment => segment.kind === "note")
      .map((note) => ({
        index: note.rawStart,
        raw: note.raw,
        caller: note.caller,
        ref: note.ref,
        text: note.text,
      }))
  }, [cell.original])
  const sourceDetailFootnotes = allFootnotes.sourceFootnotes.length > 0
    ? allFootnotes.sourceFootnotes
    : sourceDisplayFootnotes
  const sourceFootnotes = showFootnotesInline ? allFootnotes.sourceFootnotes : []
  const targetFootnotes = showFootnotesInline ? allFootnotes.targetFootnotes : []
  const hasInlineFootnotes = sourceFootnotes.length > 0 || targetFootnotes.length > 0
  const hasAnyFootnotes = sourceDetailFootnotes.length > 0 || allFootnotes.targetFootnotes.length > 0
  const showFootnotesInExpansion = footnoteViewMode === "off" && hasAnyFootnotes
  const isDocxFile = (cell.fileId ?? "").endsWith(".docx")

  useEffect(() => {
    if (cell.targetEventId) pendingTargetEventIdRef.current = cell.targetEventId
  }, [cell.targetEventId])

  const ruleSeverity = useMemo(() => {
    const m = new Map<string, "major" | "minor">()
    for (const [id, rule] of ruleMap) m.set(id, rule.severity)
    return m
  }, [ruleMap])

  const waivedRuleIds = useMemo(
    () => new Set((cell.waivers ?? []).map((w) => w.ruleId)),
    [cell.waivers],
  )

  // Stable identity across renders (cellInfractions/waivedInfractions are
  // themselves memoized in MemoizedRow) so TranslatedEditor's violation-
  // decoration-plugin rebuild effect doesn't fire on every unrelated render.
  const mergedInfractions = useMemo(
    () => [...cellInfractions, ...waivedInfractions],
    [cellInfractions, waivedInfractions],
  )

  const handleWaive = useCallback((input: { ruleId: string; reason?: string }) => {
    setOpenRuleId(null)
    if (!project.id) return
    // Emits a `cell.waive` event into the outbox. The pending-outbox overlay
    // (useCellsAuditStatsWithOverlay) reflects it on `cell.waivers` instantly
    // so the blot drops to its waived style; onCellCommitted flushes + refetches
    // the authoritative projection.
    void emitCellWaive({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      ruleId: input.ruleId,
      ...(input.reason ? { reason: input.reason } : {}),
      author: username,
    }).then(() => {
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      console.warn("[waive] emit failed:", err)
      // FRO-274: surface enqueue failure to the user so they know the waive
      // didn't persist locally — silent failure is the worst failure mode.
      setWriteError("Couldn't save this change locally — copy your text and reload.")
    })
  }, [project.id, cell.fileId, cell.id, username, onCellCommitted])

  const handleUnwaive = useCallback((ruleId: string) => {
    setOpenRuleId(null)
    if (!project.id) return
    void emitCellUnwaive({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      ruleId,
      author: username,
    }).then(() => {
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      console.warn("[unwaive] emit failed:", err)
      // FRO-274: surface enqueue failure inline.
      setWriteError("Couldn't save this change locally — copy your text and reload.")
    })
  }, [project.id, cell.fileId, cell.id, username, onCellCommitted])

  const sourceRanges = useMemo<RangeHighlight[]>(() => {
    const out: RangeHighlight[] = []
    const all = [...cellInfractions, ...waivedInfractions]
    for (const inf of all) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "source") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity])

  const targetRanges = useMemo<RangeHighlight[]>(() => {
    const out: RangeHighlight[] = []
    const all = [...cellInfractions, ...waivedInfractions]
    for (const inf of all) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "target") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity])
  const targetHasRichFormatting = hasMeaningfulRichText(cell.translatedHtml)

  // Editor commit path. The plain TipTap editor (TranslatedEditor) calls
  // this on idle/blur/release with the current `{value, valueHtml}` snapshot.
  // We emit a `target.cell.commit` event chained off cell.targetEventId
  // (AD-2) and pinned to cell.sourceEventId (AD-9 staleness pin), then ping
  // the parent to revalidate useCells so the projection lands.
  const handleEditorCommit = useCallback(({ value, valueHtml }: { value: string; valueHtml: string }) => {
    if (!editable) return
    if (!project.id) return
    // FRO-273: belt-and-suspenders role-mirror check. `editable` is already
    // false for roles < CONTRIBUTOR, so this guard only fires in the unlikely
    // race where `editable` hasn't updated yet after a role downgrade — it
    // prevents a guaranteed-403 event from entering the durable outbox.
    if (!canPerform("target.cell.commit", project.syncRole?.level ?? null)) {
      console.warn("[editor-commit] aborting: role too low for target.cell.commit")
      return
    }
    // RACE-5 — Lock re-check at commit time. Uses the ref-backed `checkLockHolder`
    // (updated synchronously on every WS frame) as the authoritative source so
    // a commit queued in the debounce window just after another user's
    // `lock.claimed` arrives can't slip through a stale React render.
    // `lockHolderLabel` (from the last render) is the fallback when offline
    // or when `checkLockHolder` is not wired. Advisory: never blocks when the
    // socket is down (offline edits still flow through; FWW handles conflicts).
    const liveHolder = checkLockHolder?.(cell.id) ?? lockHolderLabel
    if (liveHolder) {
      console.warn("[editor-commit] aborting: lock held by", liveHolder)
      void onCellCommitted?.(cell.id)
      return
    }
    // Optimistic local patch: applies BEFORE the outbox enqueue so this row's
    // signature (`status original translated`) shifts and `useHealth` re-runs
    // `checkRulesForCell` for this one cell on the next render — no other
    // cell's cached infractions are invalidated. The server projection
    // arrives via `onCellCommitted` -> revalidate and overwrites this.
    onOptimisticEdit?.(cell.id, { value, valueHtml })
    setWriteError(null)
    // RACE-3/QW-2: use the pending event id (the last event WE enqueued for this
    // cell) as parentId rather than the projection value. The projection row may
    // lag by a round-trip when a second idle-commit fires before the read-back
    // confirms; chaining from the projection value would make it a sibling of
    // our own earlier event and dead-letter it. pendingTargetEventIdRef is
    // updated from cell.targetEventId whenever the projection confirms (effect
    // at line ~1621), so it stays correct once the server catches up.
    const parentId = pendingTargetEventIdRef.current ?? cell.sourceEventId ?? null
    emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value,
      valueHtml,
      author: username,
    }).then((eventId) => {
      pendingTargetEventIdRef.current = eventId
      // Pass the just-assigned event id: the auto-BT in the parent pins to it
      // so the BT describes THIS commit, not the lagging projection head.
      void onCellCommitted?.(cell.id, eventId)
    }).catch((err) => {
      // RES-4/M1-3: enqueue failure (IDB quota, private-mode, InsufficientRoleError)
      // must be loud. Revert the optimistic patch so the cell doesn't show
      // "saved" styling for an event that exists nowhere durable.
      console.error("[editor-commit] enqueue failed:", err)
      const msg = err instanceof Error ? err.message : "Could not save — please try again"
      setWriteError(msg)
      // Revert the optimistic patch to the last confirmed projection value.
      onOptimisticEdit?.(cell.id, {
        value: cell.translated ?? "",
        valueHtml: cell.translatedHtml ?? "",
      })
    })
  }, [editable, project.id, project.syncRole?.level, cell.fileId, cell.id, cell.translated, cell.translatedHtml, cell.sourceEventId, username, onCellCommitted, onOptimisticEdit, lockHolderLabel, checkLockHolder])

  // Terminology apply (spec 2c): REPLACE the active target selection with the
  // chosen rendering. The Apply affordance is only surfaced when there was a
  // non-empty selection at chip-click time (see handleTermChipClick), and the
  // selected text is captured in targetSelectionTextRef. We replace the first
  // occurrence of that selected text in the current target plain text. When
  // there is no selection (defensive fallback), we append so the translator
  // can still chain multiple terms. Uses the same commit path as keyboard edits.
  const handleTermApply = useCallback((rendering: string) => {
    const existing = cell.translated ?? ""
    const selected = targetSelectionTextRef.current
    let next: string
    if (selected && existing.includes(selected)) {
      next = existing.replace(selected, rendering)
    } else {
      const trimmed = existing.trim()
      next = trimmed ? `${trimmed} ${rendering}` : rendering
    }
    handleEditorCommit({ value: next, valueHtml: next })
  }, [cell.translated, handleEditorCommit])

  const captureFootnoteAnchor = useCallback(() => {
    pendingFootnoteAnchorRef.current = translatedEditorRef.current?.getFootnoteInsertionAnchor() ?? null
  }, [])

  const openAddFootnoteDialog = useCallback((defaults?: AddFootnoteDialogDefaults) => {
    if (!pendingFootnoteAnchorRef.current) captureFootnoteAnchor()
    const anchor = pendingFootnoteAnchorRef.current
    const markerOptions = footnoteMarkerOptions(cell, anchor, targetFootnoteNumberOffset)
    const markerStyle = defaults?.markerStyle ?? footnoteMarkerStyleFromCaller(defaults?.caller)
    setAddFootnoteDefaults({
      caller: defaults?.caller ?? "+",
      ref: defaults?.ref ?? defaultFootnoteRef(cell),
      text: defaults?.text ?? "",
      markerStyle,
      anchorText: defaults?.anchorText ?? footnoteAnchorText(anchor),
      insertionPreview: anchor
        ? {
          before: anchor.previewBefore ?? "",
          after: anchor.previewAfter ?? "",
        }
        : undefined,
      markerOptions,
    })
    setAddFootnoteOpen(true)
  }, [captureFootnoteAnchor, cell, targetFootnoteNumberOffset])

  const handleAddFootnote = useCallback((value: AddFootnoteDialogValue) => {
    const marker = createUsfmFootnoteMarker(value)
    const inserted = translatedEditorRef.current?.insertFootnoteMarker(
      marker,
      pendingFootnoteAnchorRef.current,
    ) ?? false

    if (!inserted) {
      const next = `${cell.translated ?? ""}${marker}`
      handleEditorCommit({ value: next, valueHtml: next })
    }

    pendingFootnoteAnchorRef.current = null
    onFootnoteCreated?.()
    setAddFootnoteOpen(false)
  }, [cell.translated, handleEditorCommit, onFootnoteCreated])

  const handleCreateTargetFootnote = useCallback((sourceFootnote: ExtractedFootnote) => {
    pendingFootnoteAnchorRef.current = null
    openAddFootnoteDialog({
      caller: sourceFootnote.caller || "+",
      ref: sourceFootnote.ref || defaultFootnoteRef(cell),
      text: sourceFootnote.text,
      markerStyle: footnoteMarkerStyleFromCaller(sourceFootnote.caller),
    })
  }, [cell, openAddFootnoteDialog])

  // Add-from-selection (Slice 5): capture a source-side text selection so the
  // translator can promote it to a DRAFT concept without leaving the editor.
  const handleSourceMouseUp = useCallback(() => {
    if (!onAddConceptFromSelection && !onAskAiFromSelection) return
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : ""
    const captured = text.length > 0 ? text : null
    // FRO-260: keep the ref in sync with state so onClick handlers can read
    // the captured text even after the selectionchange race clears the state.
    capturedSelectionRef.current = captured
    setSourceSelection(captured)
  }, [onAddConceptFromSelection, onAskAiFromSelection])

  // Opens the confirm dialog — actual creation happens in handleAddConceptConfirm.
  // FRO-260: read from capturedSelectionRef (not sourceSelection state) so the
  // dialog opens even when the selectionchange event already cleared the state
  // before this onClick fires (the mousedown-blur race).
  const handleAddSelectionToTermbase = useCallback(() => {
    const text = capturedSelectionRef.current
    if (!text) return
    // Re-sync state so AddConceptDialog receives the correct pre-fill term even
    // if the selectionchange handler cleared it between mousedown and click.
    setSourceSelection(text)
    setShowAddConceptDialog(true)
  }, [])

  const handleAddConceptConfirm = useCallback(async (term: string) => {
    await onAddConceptFromSelection?.(term)
    setShowAddConceptDialog(false)
    capturedSelectionRef.current = null
    setSourceSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [onAddConceptFromSelection])

  const handleAddConceptCancel = useCallback(() => {
    setShowAddConceptDialog(false)
  }, [])

  // FRO-260: toolbar mouse-down/up guards used by the selectionchange handler.
  // Set when the user presses down on a SelectionTermActions button so the
  // FRO-248 selectionchange guard knows not to clear sourceSelection before the
  // click callback fires. Cleared on mouseup or mouseleave.
  const handleToolbarMouseDown = useCallback(() => {
    toolbarMouseDownRef.current = true
  }, [])
  const handleToolbarMouseUp = useCallback(() => {
    toolbarMouseDownRef.current = false
  }, [])

  // Promote the current source selection into the AI agent as a context chip.
  // FRO-260: read capturedSelectionRef (not state) for the same mousedown-race reason.
  const handleAskAiFromSelection = useCallback(() => {
    const text = capturedSelectionRef.current
    if (!text || !onAskAiFromSelection) return
    onAskAiFromSelection(
      buildSourceChip({
        chipId: `chip-${cell.fileId}-${cell.id}-${Date.now().toString(36)}`,
        fileId: cell.fileId,
        cellId: cell.id,
        canonicalRef: cell.context ?? cell.group ?? undefined,
        selection: text,
      }),
    )
    // Dismiss the toolbar, like the terminology path.
    capturedSelectionRef.current = null
    setSourceSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [onAskAiFromSelection, cell.fileId, cell.id, cell.context, cell.group])

  // FRO-248: clear source selection when the browser selection collapses (user
  // clicked elsewhere or selected text in a different row). This prevents the
  // "Add to termbase" toolbar from floating over a different row's content.
  // FRO-260: guard — do NOT clear when the user is pressing down on a toolbar
  // button (toolbarMouseDownRef=true). The selectionchange fires before onClick
  // in the mousedown-click sequence; clearing here would make onClick see null.
  useEffect(() => {
    if (!sourceSelection) return
    // While the AddConceptDialog is open it owns the captured term — its
    // auto-focus collapses the browser selection, and clearing sourceSelection
    // here would wipe the dialog's pre-fill (the dialog re-syncs its input
    // from the prop while open).
    if (showAddConceptDialog) return
    const handleSelectionChange = () => {
      // Suppress if the user is mid-click on the SelectionTermActions toolbar.
      if (toolbarMouseDownRef.current) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === "") {
        setSourceSelection(null)
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [sourceSelection, showAddConceptDialog])

  // Slice 4: advisory pre-acceptance terminology warnings for the AI copilot.
  // Computed against the completion text (the streaming preview while loading,
  // otherwise the committed target text) versus the cell's source and the
  // project's active concepts. ADVISORY ONLY — never gates accept/commit.
  // Recomputes naturally as the preview streams in and as the committed text /
  // BT verdict changes on later renders.
  const preAcceptanceWarnings = useMemo(() => {
    const completionText = isLoading ? (completionPreview ?? "") : (cell.translated ?? "")
    if (!completionText.trim()) return []
    return detectPreAcceptanceWarnings(
      completionText,
      cell.original ?? "",
      project.terminology ?? [],
    )
  }, [isLoading, completionPreview, cell.translated, cell.original, project.terminology])

  // FRO-204: Chip click handler for terminology chips in the target (TranslatedEditor).
  // Records whether the target editor had a non-empty text selection at click time
  // so we can conditionally surface the Apply affordance in the popover.
  const handleTermChipClick = useCallback((term: string, anchor: HTMLElement) => {
    const sel = window.getSelection()
    const selText = sel && !sel.isCollapsed ? sel.toString() : ""
    targetHasSelectionRef.current = selText.trim().length > 0
    targetSelectionTextRef.current = selText
    setTermChipState({ term, anchor })
  }, [])

  const emitValidationChange = useCallback((validated: boolean) => {
    // FRO-273: role-mirror guard — viewer/commenter should never reach here
    // (canValidate=false disables the button) but guard defensively so a
    // guaranteed-403 never enters the outbox.
    if (!canPerform(validated ? "cell.validate" : "cell.unvalidate", project.syncRole?.level ?? null)) {
      console.warn("[validate] aborting: role too low for", validated ? "cell.validate" : "cell.unvalidate")
      return
    }
    const editEventId = cell.targetEventId ?? pendingTargetEventIdRef.current
    if (!project.id || !editEventId) return
    const emit = validated ? emitCellValidate : emitCellUnvalidate
    void emit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      editEventId,
      author: username,
    }).then(() => {
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      console.warn(`[${validated ? "validate" : "unvalidate"}] emit failed:`, err)
      // FRO-274: surface enqueue failure inline.
      setWriteError("Couldn't save this change locally — copy your text and reload.")
    })
  }, [cell.fileId, cell.id, cell.targetEventId, project.id, project.syncRole?.level, username, onCellCommitted])

  const editorFocusedRef = useRef(false)
  const requestTargetEdit = useCallback(() => {
    if (!editable || isLoading) return
    onActivateEditor(cell.id)
  }, [editable, isLoading, onActivateEditor, cell.id])

  const handleEditorFocus = useCallback(() => {
    editorFocusedRef.current = true
    onActivateEditor(cell.id)
    onClaimCell?.(cell.id)
    onAckRemoteChange?.(cell.id)
  }, [cell.id, onActivateEditor, onClaimCell, onAckRemoteChange])

  const handleEditorBlurOuter = useCallback(() => {
    if (editorFocusedRef.current) {
      editorFocusedRef.current = false
      onReleaseCell?.(cell.id)
    }
    onDeactivateEditor(cell.id)
  }, [cell.id, onDeactivateEditor, onReleaseCell])

  useEffect(() => {
    if (!isEditorActive) return
    let attempts = 0
    let frame = 0
    const focusEditor = () => {
      const pm = rowRef.current?.querySelector<HTMLElement>(".ProseMirror")
      if (!pm) {
        if (attempts < 8) {
          attempts += 1
          frame = window.requestAnimationFrame(focusEditor)
        }
        return
      }
      if (document.activeElement !== pm) {
        pm.focus()
        const sel = window.getSelection()
        if (sel) {
          const range = document.createRange()
          range.selectNodeContents(pm)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
        }
      }
    }
    frame = window.requestAnimationFrame(focusEditor)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (editorFocusedRef.current) {
        editorFocusedRef.current = false
        onReleaseCell?.(cell.id)
      }
    }
  }, [isEditorActive, cell.id, onReleaseCell])

  const handleDiscardLocalAndReload = useCallback(() => {
    onAckRemoteChange?.(cell.id)
    onCellCommitted?.(cell.id)
  }, [cell.id, onAckRemoteChange, onCellCommitted])

  // Detect formatting loss: source has inline style marks that the target doesn't.
  const sourceHasFormatting = Boolean(cell.originalHtml && /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(cell.originalHtml))
  const targetHtml = cell.translatedHtml ?? ""
  const targetHasFormatting = /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(targetHtml)
  const showFormattingLossWarning =
    sourceHasFormatting && !targetHasFormatting && cell.translated.trim().length > 0

  const healthValue = health ?? (cell.status === "validated" ? 100 : 0)

  const selectedAudio = cell.selectedAudioId ? cell.attachments?.[cell.selectedAudioId] : undefined
  const hasAudio = Boolean(selectedAudio && !selectedAudio.isDeleted)
  const cellAudioTimings = cell.selectedAudioId ? cell.audioTimings?.[cell.selectedAudioId] : undefined
  const selectedGeneratedVoice = cell.selectedGeneratedVoiceAudioId
    ? cell.attachments?.[cell.selectedGeneratedVoiceAudioId]
    : undefined
  const hasGeneratedVoice = Boolean(selectedGeneratedVoice && !selectedGeneratedVoice.isDeleted)
  const generatedVoiceTimings = cell.selectedGeneratedVoiceAudioId
    ? cell.audioTimings?.[cell.selectedGeneratedVoiceAudioId]
    : undefined

  // Minimal CodexCell shape for the audio hook — useCellAudio only ever reads
  // cell.metadata.selectedAudioId and cell.metadata.attachments[selectedAudioId]
  // (verified in useCellAudio.ts), so the dep array is narrowed to exactly
  // those fields. Previously this depended on cell.id/cell.type/cell.translated
  // too, so every debounced text commit reallocated both objects and
  // re-triggered downstream effects keyed on their identity.
  const cellForAudio = useMemo(() => ({
    metadata: {
      attachments: cell.attachments,
      selectedAudioId: cell.selectedAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.attachments, cell.selectedAudioId,
  ])
  const audioController = useCellAudio(project, cellForAudio, cell.fileId)
  const cellForGeneratedVoice = useMemo(() => ({
    metadata: {
      attachments: cell.attachments,
      selectedAudioId: cell.selectedGeneratedVoiceAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.attachments, cell.selectedGeneratedVoiceAudioId,
  ])
  const generatedVoiceController = useCellAudio(project, cellForGeneratedVoice, cell.fileId)

  // When this cell starts playing, gently bring it into view if it's
  // off-screen. Skips when the user is actively interacting with another cell
  // (focus inside an editable element).
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current
    const anyPlaying = audioController.isPlaying || generatedVoiceController.isPlaying
    wasPlayingRef.current = anyPlaying
    if (!wasPlaying && anyPlaying && rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect()
      const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight
      const ae = document.activeElement
      const userIsTyping = ae instanceof HTMLElement && (
        ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"
      )
      if (!fullyVisible && !userIsTyping) {
        rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
  }, [audioController.isPlaying, generatedVoiceController.isPlaying])
  const transcribeStatus = useTranscribeStatus(cell.selectedAudioId)
  const isTranscribing = transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing"
  const transcriptPreviewRef = useRef<HTMLDivElement | null>(null)
  const { session: rowSession } = useFrontierSession()

  const handleTranscribe = useCallback(async () => {
    if (!cell.selectedAudioId) return
    void transcribeCell({ cell, session: rowSession, projectId: project.id, language: project.targetLanguage })
  }, [cell, rowSession, project.id, project.targetLanguage])

  const vs = cell.validationStatus
  const [validationPopoverOpen, setValidationPopoverOpen] = useState(false)
  const isSelfValidated = cell.activeValidators.includes(username)
  const hasValidatorInfo = cell.activeValidators.length > 0 || cell.validationHistory.length > 1

  // Gate Base UI's auto-toggle: clicks on an unvalidated cell should validate
  // (not open the popover), and hovers should only open when there's actually
  // something to show. Everything else passes through to the default behavior,
  // including outside-press / escape-key closes.
  function handleOpenChange(
    nextOpen: boolean,
    details: { reason: string; cancel(): void },
  ) {
    if (!nextOpen) {
      setValidationPopoverOpen(false)
      return
    }
    // "keyboard" fires when activated via Space/Enter; "trigger-press" fires
    // on pointer press. The trigger button's own click handler performs the
    // validation, so the popover only needs to stay closed on first touch.
    if (details.reason === "trigger-press" || details.reason === "keyboard") {
      if (canValidate && !isSelfValidated) {
        details.cancel()
        return
      }
      setValidationPopoverOpen(true)
      return
    }
    if (details.reason === "trigger-hover" && !hasValidatorInfo) {
      details.cancel()
      return
    }
    setValidationPopoverOpen(true)
  }

  // "others" now uses a filled Circle (lucide has no dedicated filled-circle
  // icon; we render Circle with fill="currentColor"). Matches codex-editor
  // desktop AudioValidationStatusIcon's circle-filled codicon.
  // full-self = fully validated and current user is one of the validators (double-check, green)
  // full-others = fully validated but current user has NOT validated (double-check, green)
  const ValidationIcon =
    vs === "full-self" || vs === "full-others" ? CheckCheck :
    vs === "self" ? Check :
    Circle
  const validationColorClass =
    vs === "full-self" ? "text-green-500" :
    vs === "full-others" ? "text-green-500" :
    vs === "self" ? "text-green-500" :
    vs === "others" ? "text-muted-foreground/60" :
    "text-muted-foreground/30"

  const hasContent = Boolean(cell.translated && cell.translated.trim())

  // AD-14 amendment 2026-06-04: use server-derived confidence score from
  // healthMap when available (set by the confidence overlay in ProjectWorkspace
  // via useCellConfidence). Falls back to endorsement_count decay for
  // local-only projects or while the server confidence loads.
  // Absence of the marker is silence, not endorsement — no green "done" ring.
  const decayConfig = useMemo(
    () => resolveDecayConfig(project.decaySettings, readValidationCount(project)),
    [project.decaySettings, project.validationCount],
  )
  const cellNeedsAttention = hasContent && (
    health !== undefined
      ? needsAttentionFromConfidence(health, decayConfig.decayWarnThreshold)
      : needsAttention(cell.endorsementCount ?? 0, decayConfig)
  )

  const hasMajorInfraction = cellInfractions.some(
    (i) => ruleMap.get(i.ruleId)?.severity === "major",
  )
  const infractionCount = cellInfractions.length


  // SECURITY: originalHtml below is sanitized through DOMPurify.sanitize() at
  // the render boundary. Parsers only produce safe inline tags (<b>, <i>, <u>,
  // <s>, <code>). DOMPurify provides defense-in-depth against XSS.
  const showLineNumber = lineNumbersEnabled && cell.type !== "paratext"
  // Prefer the explicitly-assigned cast member's name; fall back to the cell's
  // own label (e.g. a chapter/verse marker from USFM), then nothing.
  const castVoiceId = cellLabelsEnabled ? assignedCastVoiceId(project.ttsSettings, cell.id) : undefined
  const castName = castVoiceId ? findVoice(project.ttsSettings, castVoiceId)?.name : undefined
  const labelText = castName ?? cell.cellLabel ?? null
  const showCellLabel = cellLabelsEnabled && labelText

  // The cell number tints by worst severity. That's the whole signal — the
  // concrete issue list lives in the expansion's Issues tab, not in a hover
  // popover here. (Replaced the old severity stripe / warning triangle / dot;
  // the cast label moved to the target column header lane so it isn't squished
  // into this 44px gutter.)
  const hasAnyIssue = infractionCount > 0 || cellNeedsAttention
  const numberLabel = showLineNumber ? String(rowIndex + 1) : null
  const numberPill = !showLineNumber ? null : (
    <span className="flex h-6 items-center" aria-label={`Line ${numberLabel}`}>
      <CellNumberPill
        number={numberLabel}
        plain
        tint={hasMajorInfraction ? "major" : hasAnyIssue ? "issue" : "none"}
      />
    </span>
  )

  // ── Hover / focus / tap state for the floating action rail ───────────────
  // Three input sources OR'd together: row hover, focus-within, tap-selected
  // (touch). Hover-leave has a 120ms grace period to prevent flicker as the
  // cursor grazes adjacent rows.
  const [isHovering, setIsHovering] = useState(false)
  const [hasFocusWithin, setHasFocusWithin] = useState(false)
  const [isTapSelected, setIsTapSelected] = useState(false)
  const hoverLeaveTimerRef = useRef<number | null>(null)

  // ── Expansion state ───────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState(false)
  const [expansionTab, setExpansionTab] = useState<string>("backtranslation")
  const alignmentModelForExpansion = useMemo(() => {
    if (!expanded || expansionTab !== "backtranslation") return null
    if (!cell.original.trim() || !cell.translated.trim()) return null
    return getAlignmentModel?.() ?? null
  }, [cell.original, cell.translated, expanded, expansionTab, getAlignmentModel])

  // History tab: fetch the D1 event log on demand only when the History tab is
  // visible. `cell.history` from useCells is intentionally empty (EMPTY_HISTORY)
  // — the audit trail lives in the sync-worker, not the cell projection.
  const historyTokenFetcher = useMemo(() => {
    return getTokenForFile ?? (async (_fileId: string) => null as string | null)
  }, [getTokenForFile])
  const {
    history: fetchedHistory,
    isLoading: isHistoryLoading,
    isError: isHistoryError,
  } = useCellEditHistory({
    enabled: expanded && expansionTab === "history" && Boolean(getTokenForFile),
    projectId: project?.id ?? null,
    fileId: cell.fileId ?? null,
    cellId: cell.id,
    getTokenForFile: historyTokenFetcher,
  })

  // ── Compute attention signals for chevron + tab dots ──────────────────────
  const isBtStale = Boolean(
    cell.backtranslation && cell.backtranslationForText !== cell.translated,
  )
  const transcriptText = useMemo(() => {
    if (!cellAudioTimings || cellAudioTimings.length === 0) return ""
    return cellAudioTimings.map((t) => t.word).join(" ")
  }, [cellAudioTimings])
  const transcriptMatchesCellText = useMemo(() => {
    if (!hasAudio || !transcriptText) return true
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
    return norm(transcriptText) === norm(cell.translated)
  }, [hasAudio, transcriptText, cell.translated])
  const transcriptNeedsAttention =
    hasAudio &&
    Boolean(cellAudioTimings && cellAudioTimings.length > 0) &&
    !transcriptMatchesCellText
  const chevronAttentionDot: "red" | "amber" | "emerald" | "primary" | null =
    cellInfractions.length > 0
      ? hasMajorInfraction
        ? "red"
        : "amber"
      : isBtStale
        ? "amber"
        : transcriptNeedsAttention
          ? "amber"
          : null

  // First-open auto-tab: prefer the most-attention-worthy tab. Only applied
  // when the panel was closed and is being opened — once open, the user's
  // choice (or programmatic switches via inline rule clicks) wins.
  const previousExpandedRef = useRef(false)
  useEffect(() => {
    if (expanded && !previousExpandedRef.current) {
      const initial =
        cellInfractions.length > 0
          ? "issues"
          : transcriptNeedsAttention
            ? "audio"
            : "backtranslation"
      setExpansionTab(initial)
    }
    previousExpandedRef.current = expanded
  }, [expanded, cellInfractions.length, transcriptNeedsAttention])

  useEffect(() => {
    if (expansionTab === "footnotes" && !showFootnotesInExpansion) {
      setExpansionTab("backtranslation")
    }
  }, [expansionTab, showFootnotesInExpansion])

  const railRevealed = isHovering || hasFocusWithin || isTapSelected || expanded

  // ── BT tab edit state ─────────────────────────────────────────────────────
  const [btEditing, setBtEditing] = useState(false)
  const [btEditValue, setBtEditValue] = useState("")
  const [btPolishOn, setBtPolishOn] = useState(false)
  const [btSaving, setBtSaving] = useState(false)

  // When editing starts, seed the input with the current BT text.
  const handleBtEditStart = useCallback(() => {
    setBtEditValue(cell.backtranslation ?? "")
    setBtEditing(true)
  }, [cell.backtranslation])

  const handleBtSave = useCallback(() => {
    if (!btEditValue.trim()) {
      setBtEditing(false)
      return
    }
    setBtSaving(true)
    try {
      onSaveBacktranslation?.(cell, btEditValue.trim(), btPolishOn)
    } finally {
      setBtSaving(false)
      setBtEditing(false)
    }
  }, [btEditValue, btPolishOn, cell, onSaveBacktranslation])

  const handleBtCancel = useCallback(() => {
    setBtEditing(false)
    setBtEditValue("")
  }, [])

  // Stable rail handlers
  const handleRowMouseEnter = () => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current)
      hoverLeaveTimerRef.current = null
    }
    setIsHovering(true)
  }
  const handleRowMouseLeave = () => {
    if (hoverLeaveTimerRef.current !== null) window.clearTimeout(hoverLeaveTimerRef.current)
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      setIsHovering(false)
      hoverLeaveTimerRef.current = null
    }, 120)
  }
  const handleRowFocusCapture = () => setHasFocusWithin(true)
  const handleRowBlurCapture = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (next && rowRef.current?.contains(next)) return
    setHasFocusWithin(false)
    // FRO-248: clear source-text selection when focus leaves this row so the
    // "Add to termbase" toolbar never floats over a different row's content.
    capturedSelectionRef.current = null
    setSourceSelection(null)
  }
  const handleRowClick = (e: React.MouseEvent) => {
    // Cmd/Ctrl-click → toggle multi-select. Wins even over text editors and
    // buttons so the user can grab cells without aiming at a tiny gutter.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleSelected(cell.id)
      return
    }
    if (isInteractiveTarget(e.target)) return
    // Plain click clears any active multi-selection so the next interaction
    // doesn't surprise the user with a stale bulk action target.
    clearSelection()
    setIsTapSelected((p) => !p)
  }

  /**
   * Cmd/Ctrl-mousedown also has to be intercepted *before* the click — content-
   * editable surfaces (TipTap/ProseMirror) handle mousedown to place the
   * caret, and `preventDefault` on the later click event can't undo that. We
   * stop the gesture at mousedown when a modifier is held; the click handler
   * still fires and toggles the selection.
   */
  const handleRowMouseDownCapture = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // Inline rule click → open expansion to issues tab and remember which rule
  // (and which blot DOM node) is active so the ViolationPopover can anchor to
  // the blot directly rather than to a stray span at the bottom of the row.
  const openInlineRule = useCallback((ruleId: string, anchor: HTMLElement) => {
    setExpanded(true)
    setExpansionTab("issues")
    setOpenRuleId(ruleId)
    setOpenRuleAnchor(anchor)
  }, [])

  const isMultiSelected = useIsSelected(cell.id)
  const synthStatus = useTtsStatus(ttsStatusKey(cell.id))
  const isSynthBusy = synthStatus.kind === "loading" || synthStatus.kind === "synthesizing"
  const isSynthError = synthStatus.kind === "error"

  // FRO-297: Accessible label for the target editor textbox.
  // Format: "<ref> — <state>" so screen readers announce context on focus.
  // Uses cell.context (the canonical reference like "GEN 1:1") when available,
  // falls back to globalReferences[0], then rowIndex+1.
  const cellRef = cell.context?.trim()
    || cell.globalReferences?.[0]?.trim()
    || `row ${rowIndex + 1}`
  const validationTooltip = canValidate ? "Not validated — click to validate" : "Validation unavailable"
  type PreventableReactEvent<T> = React.SyntheticEvent<T> & {
    preventBaseUIHandler?: () => void
  }
  const renderValidationButton = (onClick?: () => void) => (
    <button
      type="button"
      // FRO-297: button role + aria-pressed so screen readers announce the
      // validated/unvalidated toggle state. aria-label provides full context.
      aria-pressed={isSelfValidated}
      aria-label={
        isSelfValidated
          ? `Validated — ${cellRef}. Click to remove your validation.`
          : vs === "full-others" || vs === "others"
            ? `Validated by others — ${cellRef}. Click to add your validation.`
            : `Not validated — ${cellRef}. Click to validate.`
      }
      onClick={(e) => {
        if (!onClick) return
        onClick()
        ;(e as PreventableReactEvent<HTMLButtonElement>).preventBaseUIHandler?.()
      }}
      onKeyDown={(e) => {
        if (!onClick || (e.key !== " " && e.key !== "Enter")) return
        e.preventDefault()
        e.stopPropagation()
        onClick()
        ;(e as PreventableReactEvent<HTMLButtonElement>).preventBaseUIHandler?.()
      }}
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded-full transition-[transform,color,background-color] duration-150 ease-out",
        "active:scale-[0.88] disabled:cursor-not-allowed disabled:opacity-30",
        "hover:bg-muted/80",
        validationColorClass,
        vs === "none" && "hover:text-green-500",
        vs === "others" && "hover:text-green-500",
        vs === "full-others" && "hover:text-green-500",
      )}
      disabled={!canValidate}
    >
      <HealthRing
        health={healthValue}
        size={22}
        strokeWidth={2}
        className="pointer-events-none"
        style={{ position: "absolute", inset: 0 }}
      />
      <ValidationIcon
        className="relative h-3.5 w-3.5"
        strokeWidth={2.5}
        {...(vs === "others" ? { fill: "currentColor" } : {})}
      />
    </button>
  )
  const cellStateLabel =
    cell.status === "validated" ? "validated" :
    cell.status === "empty" ? "empty" :
    isSelfValidated ? "self-validated" :
    "unvalidated"
  const editorAriaLabel = `${cellRef} — ${cellStateLabel}`

  // FRO-297: Grid-row keydown handler. Fires when the row wrapper div has
  // focus (not TipTap). Arrow keys / j / k navigate between rows; Enter
  // moves focus into the cell's TipTap editor (entering edit mode).
  const handleGridRowKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only act when the grid row wrapper itself is focused, not a child element
    // (child interactive elements handle their own keyboard events).
    if (e.target !== e.currentTarget) return
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      onGridRowKeyNav("next")
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      onGridRowKeyNav("prev")
    } else if (e.key === "Enter") {
      e.preventDefault()
      requestTargetEdit()
    }
  }, [onGridRowKeyNav, requestTargetEdit])

  return (
    // Each cell is a flat row in a continuous list — no dividers; rows separate
    // by spacing and hover/selection overlays alone (Linear's quietest list).
    // The expansion panel is indented + bordered so it still reads as the row's
    // child. No card, no shadow.
    <div>
      <div
        ref={rowRef}
        // FRO-297: tabIndex={0} makes the row wrapper a focus stop for
        // grid-level keyboard navigation (ArrowUp/Down, j/k, Enter).
        // focus-visible:outline shows a subtle ring when navigating by
        // keyboard so the focused row is clear to sighted keyboard users.
        data-grid-row
        tabIndex={0}
        aria-label={`${cellRef} cell`}
        className={cn(
          // Flat row in a continuous list: tinted by hover/selection overlays,
          // not shadows. Depth is gone by design — the Linear model reserves
          // elevation for floating layers.
          "group relative grid gap-2 overflow-hidden px-4 py-2 transition-colors duration-150 ease-out",
          hasInlineFootnotes && "gap-y-1 py-1.5",
          // Keyboard-focus ring for the grid row (only when focused directly,
          // not via a child element — :focus-visible + :not(:focus-within:not(:focus))).
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
          // Hover/active well via a subtle background overlay.
          "hover:bg-muted/50",
          expanded && "bg-muted/50",
          audioController.isPlaying && "bg-muted/40",
          // Multi-select: tinted fill + a subtle gold inset ring.
          isMultiSelected && "bg-primary/5 ring-1 ring-primary/40 ring-inset",
          // Open-comments accent — a soft inset ring.
          openCommentCount > 0 && "ring-1 ring-blue-400/50 ring-inset",
          // Active cue highlight — tinted fill + gold ring.
          _isActiveCue && "bg-primary/5 ring-1 ring-primary/40 ring-inset",
          // Pulsing while a voice is being generated for this cell. Gives the
          // user a clear "something is happening" signal — drop, translate,
          // and bulk synth all flow through this status key.
          isSynthBusy && "bg-primary/5 ring-2 ring-primary/50 ring-inset animate-pulse",
          isSynthError && "bg-destructive/5 ring-2 ring-destructive/50 ring-inset",
          gridCols,
        )}
        onMouseEnter={handleRowMouseEnter}
        onMouseLeave={handleRowMouseLeave}
        onFocusCapture={handleRowFocusCapture}
        onBlurCapture={handleRowBlurCapture}
        onMouseDownCapture={handleRowMouseDownCapture}
        onClick={handleRowClick}
        onKeyDown={handleGridRowKeyDown}
      >
        {/* Left gutter — a subtle line number sits to the LEFT of the
            validation circle, both anchored to the top of the card. The number
            is the single issue surface (severity tint + title); no
            stripe/dot/warning. Selection lives on the source/target divider so
            range selection follows the text. */}
        <div className="flex h-full items-start justify-center gap-1 pt-5">
          {numberPill}
          {/* Validation circle — single bare icon until validated, with a
              health ring appearing around it once there's a substantive score. */}
          {hasContent && hasValidatorInfo && (
            <Popover open={validationPopoverOpen} onOpenChange={handleOpenChange}>
              <PopoverTrigger
                openOnHover
                delay={400}
                closeDelay={100}
                render={renderValidationButton(
                  canValidate && !isSelfValidated
                    ? () => emitValidationChange(true)
                    : undefined,
                )}
              />
              {vs !== "empty" && (
                <PopoverContent
                  side="right"
                  align="start"
                  className="w-72 rounded-xl p-2 shadow-lg"
                >
                  <ul className="space-y-0.5">
                    <li className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Validated by
                    </li>
                    {cell.activeValidators.length === 0 ? (
                      <li className="px-1 py-1 text-xs text-muted-foreground">No active validators</li>
                    ) : (
                      cell.activeValidators.map((v) => (
                        <li key={v} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                          <span className="truncate">{v}{v === username ? " (you)" : ""}</span>
                          {v === username && canValidate && (
                            <AppTooltip content="Remove your validation">
                              <button
                                type="button"
                                aria-label="Remove your validation"
                                className="flex-shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => {
                                  emitValidationChange(false)
                                  setValidationPopoverOpen(false)
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </AppTooltip>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                  {cell.validationHistory.length > 0 && (
                    <ValidationHistoryTimeline entries={cell.validationHistory} currentUsername={username} />
                  )}
                </PopoverContent>
              )}
            </Popover>
          )}
          {hasContent && !hasValidatorInfo && (
            <AppTooltip content={validationTooltip}>
              {renderValidationButton(
                canValidate && !isSelfValidated
                  ? () => emitValidationChange(true)
                  : undefined,
              )}
            </AppTooltip>
          )}
          {/* Stale-source indicator alongside validate button */}
          {isStaleSource && hasContent && (
            <StaleSourceIndicator
              cellId={cell.id}
              staleCellIds={new Set([cell.id])}
            />
          )}
          {(isSynthBusy || isSynthError) && (
            <SynthStatusBadge status={synthStatus} cellId={cell.id} projectId={project.id} onOpenAudioSetup={onOpenAudioSetup} />
          )}
          {/* FRO-192: assignee avatar chip — shows initials of the member
              this cell is assigned to. Tooltip = username + scope label. */}
          {assigneeLabel && (
            <AppTooltip content={assigneeNote ? `Assigned to ${assigneeLabel} (${assigneeNote})` : `Assigned to ${assigneeLabel}`}>
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[8px] font-semibold uppercase text-indigo-700 ring-1 ring-indigo-300 dark:bg-indigo-900 dark:text-indigo-300 dark:ring-indigo-700">
                {assigneeLabel.slice(0, 2)}
              </span>
            </AppTooltip>
          )}
        </div>

        {/* Source column. In Audio mode there's no need for source text to
            voice a line, so the column is REPLACED with this cell's voice
            controls (character picker, generate, play, make-a-character). In
            Text mode it shows the source text as usual. */}
        {audioLens ? (
          (() => {
            const vid = assignedCastVoiceId(audioLens.settings, cell.id) ?? audioLens.defaultVoiceId
            const resolvedVoice =
              audioLens.voices.find((v) => v.id === vid) ?? audioLens.voices[0]
            if (!resolvedVoice) return <div />
            return (
              <div
                className={cn("flex flex-col transition-opacity", isSynthBusy && "opacity-70")}
                dir="ltr"
              >
                <CellVoicePanel
                  cell={cell}
                  project={audioLens.project}
                  projectId={audioLens.projectId}
                  settings={audioLens.settings}
                  voices={audioLens.voices}
                  resolvedVoice={resolvedVoice}
                  session={audioLens.session}
                  username={audioLens.username}
                  onAssign={(voiceId) => audioLens.onAssignCast(cell.id, voiceId)}
                  onAfterGenerate={audioLens.onAfterGenerate}
                  onPlay={() => audioLens.onPlayCell(cell.id, cell)}
                  onMakeCharacter={() => audioLens.onMakeCharacterFromCell(cell.id)}
                />
              </div>
            )
          })()
        ) : (
          <div
            className={cn(
              "relative flex flex-col transition-opacity",
              isSynthBusy && "opacity-70",
            )}
            dir={sourceTextDirection}
            aria-label="Source text"
            data-cell-type="source"
            style={{ fontSize: `${sourceFontSize}px`, lineHeight: "1.6" }}
            onMouseUp={(onAddConceptFromSelection || onAskAiFromSelection) ? handleSourceMouseUp : undefined}
          >
            {/* Source-selection toolbar. Appears when source text is selected:
                "Ask AI" pushes the selection into the agent as a context chip,
                "Add to terms" promotes it to a DRAFT concept, and a "View term"
                button appears when the selection matches an active concept. */}
            {sourceSelection && (
              <SourceSelectionToolbar
                sourceSelection={sourceSelection}
                concepts={project.terminology ?? []}
                onAskAi={handleAskAiFromSelection}
                onAddToTermbase={onAddConceptFromSelection ? handleAddSelectionToTermbase : undefined}
                onTermApply={handleTermApply}
                onToolbarMouseDown={handleToolbarMouseDown}
                onToolbarMouseUp={handleToolbarMouseUp}
              />
            )}
            <div className="mb-1 flex h-4 items-center gap-1 text-xs text-muted-foreground" dir="ltr">
              <span>{cell.context}</span>
              {showFormattingLossWarning && (
                <AppTooltip content="Source has inline formatting that the target does not preserve. Formatting will be lost on export." className="max-w-xs">
                  <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    formatting
                  </span>
                </AppTooltip>
              )}
            </div>
            <SourceReferenceAttachments metadata={cell.metadata} />
            {cell.originalHtml ? (
              <SanitizedRichHtml html={cell.originalHtml} />
            ) : (
              <UsfmSourceText
                text={cell.original}
                highlights={highlights}
                ranges={sourceRanges}
                showEvidence={examplesExpanded}
                onRangeClick={openInlineRule}
                concepts={project.terminology ?? []}
                onTermApply={handleTermApply}
                footnotePanelActive={footnotePanelActive}
                footnoteNumberOffset={sourceFootnoteNumberOffset}
              />
            )}
            {cellExamples.length > 0 && (
              <ExamplePanel
                examples={cellExamples}
                expanded={examplesExpanded}
                onExpandedChange={setExamplesExpanded}
              />
            )}
          </div>
        )}

        {/* Target column — TipTap is inline so typing is unchanged. Everything
            else (waveform, transcript preview, backtranslation, infractions
            detail) lives in the expansion panel. pr-9 reserves space for the
            ever-present chevron at the right edge. */}
        <div
          className={cn(
            "relative flex flex-col pl-3 pr-9 transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          dir={targetTextDirection}
          style={{ fontSize: `${targetFontSize}px`, lineHeight: "1.6" }}
        >
          {/* SWARM-TODO(voice-a5): "Voice together" multi-cell selection gives
              no visual feedback and the action bar never appears. Root cause:
              the drag-selection affordance (onPointerDown) uses setSelection()
              via handleSelectionPointerDown in ProjectWorkspace but the
              SelectionBar's useSelectedIds() doesn't react — likely because
              the pointerdown handler only fires on drag (not click) and a
              single tap does not call toggleSelected. Investigate:
                1. Does a pointer-drag across two cells actually call setSelection?
                2. Does SelectionBar mount when activeFileId is set but the bar
                   doesn't appear because selected.size stays 0?
                3. Consider adding a click handler that calls toggleSelected so
                   single-cell selection gives immediate visual feedback, then
                   the SelectionBar ("X selected" pill) appears for discoverability.
              See: src/components/SelectionBar.tsx, src/lib/audio/selection.ts */}
          <AppTooltip content={isMultiSelected ? "Selected. Drag up or down to extend the range." : "Select cell. Drag up or down to select a range."} side="right">
            <button
              type="button"
              role="checkbox"
              aria-checked={isMultiSelected}
              aria-label={isMultiSelected ? "Selected cell. Drag to extend selection." : "Select cell. Drag to select a range."}
              onPointerDown={onSelectionPointerDown}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "absolute left-0 top-8 z-20 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border",
                "touch-none cursor-ns-resize transition-[opacity,transform,color,background-color] duration-150 ease-out",
                "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2",
                isMultiSelected
                  ? "border-transparent bg-primary text-primary-foreground opacity-100"
                  : "border-border bg-card text-muted-foreground/70 opacity-60 hover:text-primary group-hover:opacity-100",
              )}
            >
              {isMultiSelected ? (
                <Check className="h-3 w-3" strokeWidth={3} />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              )}
            </button>
          </AppTooltip>
          {/* Header lane — mirrors the source column's context line so the
              target's first text line aligns with the source text, and gives
              the floating action rail a lane of its own instead of letting it
              cover the first line of target text. The cast/character label
              lives here (left side), not squished into the line-number pill. */}
          <div className="mb-1 flex h-4 items-center text-xs text-muted-foreground" dir="ltr">
            {showCellLabel && (
              <AppTooltip content={labelText} disabled={!labelText}>
                <span className="max-w-[60%] truncate">
                  {labelText}
                </span>
              </AppTooltip>
            )}
          </div>
          <div className="flex flex-1 flex-col">
            {/* Target is a cheap read surface at rest. It upgrades to TipTap
                only for the active cell, which keeps scrolling from mounting
                dozens of ProseMirror instances. */}
            <div
              data-cell-type="target"
              className={cn(
                "relative flex min-h-[40px] flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors",
                hasInlineFootnotes && "min-h-0 py-0.5",
                "hover:bg-muted/60 focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
                !cell.translated?.trim() && "bg-muted/40",
              )}
            >
                {isEditorActive ? (
                  <TranslatedEditor
                    ref={translatedEditorRef}
                    cellId={cell.id}
                    initialPlain={cell.translated}
                    initialHtml={cell.translatedHtml}
                    onCommit={handleEditorCommit}
                    onFocus={handleEditorFocus}
                    onBlur={handleEditorBlurOuter}
                    className={cn(
                      "w-full",
                      showCompletionOverlay && "opacity-30 transition-opacity",
                    )}
                    compactHeight={hasInlineFootnotes}
                    editable={editable && !isLoading}
                    heldByLabel={lockHolderLabel}
                    infractions={mergedInfractions}
                    ruleSeverity={ruleSeverity}
                    waivedRuleIds={waivedRuleIds}
                    onRuleClick={openInlineRule}
                    audioTimings={cellAudioTimings}
                    audioCurrentTime={hasAudio ? audioController.currentTime : undefined}
                    onSeekToTime={hasAudio ? audioController.seek : undefined}
                    remoteChangedDuringEdit={remoteChangedWhileFocused}
                    onDiscardLocal={handleDiscardLocalAndReload}
                    onNavigateCell={onNavigateCell}
                    terminologyConcepts={project.terminology ?? []}
                    onTermChipClick={handleTermChipClick}
                    footnoteNumberOffset={targetFootnoteNumberOffset}
                    showFootnoteTooltips={!footnotePanelActive}
                    onFootnoteHover={(index) => {
                      setActiveFootnoteIndex(index)
                      onFootnoteHoverChange?.(index === null ? null : { cellId: cell.id, index })
                    }}
                    ariaLabel={editorAriaLabel}
                    onEscapeToGrid={onEscapeToGrid}
                  />
                ) : (
                  <div
                    role="textbox"
                    aria-multiline="true"
                    aria-readonly={!editable || isLoading || Boolean(lockHolderLabel)}
                    aria-label={editorAriaLabel}
                    data-target-read-view
                    tabIndex={editable && !isLoading ? 0 : undefined}
                    className={cn(
                      "min-h-[40px] w-full whitespace-pre-wrap rounded-lg px-1 py-0.5 leading-relaxed text-foreground/90 outline-none",
                      "focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1",
                      showCompletionOverlay && "opacity-30 transition-opacity",
                      !cell.translated?.trim() && "text-muted-foreground/60",
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestTargetEdit()
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      event.stopPropagation()
                      requestTargetEdit()
                    }}
                  >
                    {lockHolderLabel && (
                      <div
                        aria-live="polite"
                        className="pointer-events-none absolute right-1 top-1 z-10 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                      >
                        {lockHolderLabel} is editing
                      </div>
                    )}
                    {targetHasRichFormatting && cell.translatedHtml ? (
                      <TargetRichHtml
                        html={cell.translatedHtml}
                        footnotePanelActive={footnotePanelActive}
                        footnoteNumberOffset={targetFootnoteNumberOffset}
                      />
                    ) : cell.translated?.trim() ? (
                      <TargetReadText
                        text={cell.translated}
                        ranges={targetRanges}
                        concepts={project.terminology ?? []}
                        onRangeClick={openInlineRule}
                        onTermChipClick={handleTermChipClick}
                        footnotePanelActive={footnotePanelActive}
                        footnoteNumberOffset={targetFootnoteNumberOffset}
                      />
                    ) : (
                      <span aria-hidden="true" className="block min-h-[1.6em]" />
                    )}
                  </div>
                )}
              {/* FRO-204: Terminology chip popover — controlled via termChipState.
                  Anchored to the chip DOM element that was clicked. Apply is
                  offered only when the target had a non-empty text selection
                  at click time (per spec).
                  We pass a dummy <span/> trigger so TermLookupPopover renders
                  the popover body; the BaseUI Popover controlled-open + external
                  anchor positions it on the clicked chip. */}
              {termChipState && (() => {
                const concepts = project.terminology ?? []
                const onApply = targetHasSelectionRef.current
                  ? (rendering: string) => { handleTermApply(rendering); setTermChipState(null) }
                  : undefined
                return (
                  <TermLookupPopover
                    sourceTerm={termChipState.term}
                    concepts={concepts}
                    onApply={onApply}
                    open
                    onOpenChange={(isOpen: boolean) => { if (!isOpen) setTermChipState(null) }}
                    anchor={termChipState.anchor}
                  >
                    <span />
                  </TermLookupPopover>
                )
              })()}
              {/* Streaming preview overlay — visible while the LLM is
                  running and the target is still empty. Once committed text
                  is present, the editor becomes the single visible layer even
                  if completion cleanup is still in flight. */}
              {showCompletionOverlay && (
                <div
                  aria-live="polite"
                  aria-busy="true"
                  className="pointer-events-none absolute inset-0 flex"
                >
                  {completionPreview ? (
                    /* Streaming preview flows top-down like normal cell
                       text — same metrics as TipTap underneath so the
                       handoff at isLoading=false has no visible jump. */
                    <p className="whitespace-pre-wrap px-2 py-1 leading-relaxed text-foreground/90">
                      {completionPreview}
                      <span
                        aria-hidden
                        className="ml-0.5 inline-block h-3.5 w-[2px] -mb-0.5 animate-pulse bg-primary/70 align-middle"
                      />
                    </p>
                  ) : (
                    /* Pre-stream spinner — centered so it doesn't overlap
                       any existing target text peeking through the dimmed
                       editor underneath. */
                    <div className="m-auto flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-muted-foreground">
                      <Spinner className="size-3.5" aria-hidden />
                      <span>
                        {loadingPhase === "searching"
                          ? "Looking up similar examples…"
                          : "Generating translation…"}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {hasInlineFootnotes && (
              <FootnoteInline
                sourceFootnotes={sourceFootnotes}
                targetFootnotes={targetFootnotes}
                editable={editable}
                isDocx={isDocxFile}
                onSave={(footnoteIndex, newText) => {
                  const updated = spliceFootnoteText(cell.translated ?? "", footnoteIndex, newText)
                  handleEditorCommit({ value: updated, valueHtml: updated })
                }}
                onDelete={(footnoteIndex) => {
                  const updated = deleteFootnote(cell.translated ?? "", footnoteIndex)
                  handleEditorCommit({ value: updated, valueHtml: updated })
                }}
                onCreateTarget={handleCreateTargetFootnote}
                numberOffset={targetFootnoteNumberOffset}
                activeFootnoteIndex={activeFootnoteIndex}
                compact
              />
            )}
            {/* Slice 4: advisory terminology warning band for the copilot
                completion. Renders nothing when there are no warnings; never
                blocks accept/commit. */}
            <PreAcceptanceWarningBand warnings={preAcceptanceWarnings} className="mt-1" />
            {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
            {/* FRO-297: polite live region for transient inline feedback that
                is NOT already assertive (FRO-274 write-failure banners use
                role="alert" aria-live="assertive" — don't double-announce those).
                This region announces completion-phase transitions ("Generating…")
                and other non-critical status changes to screen readers. */}
            <div
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {isLoading && !completionPreview
                ? (loadingPhase === "searching"
                    ? `${cellRef}: Looking up similar examples…`
                    : `${cellRef}: Generating translation…`)
                : isLoading && completionPreview
                  ? `${cellRef}: Translation preview available`
                  : null}
            </div>
            {/* FRO-274: write-failure banner — shown when an outbox enqueue
                fails (IndexedDB unavailable, quota exceeded, etc.). The user
                must be told immediately so they can copy their text before
                reloading rather than silently losing it. */}
            {writeError && (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-1 flex items-start justify-between gap-2 rounded-xl bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive dark:bg-destructive/20"
              >
                <span>{writeError}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setWriteError(null)}
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-destructive hover:bg-destructive/20"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Floating action rail — anchored to the row's right edge, aligned
            with the target column's header lane so it never covers the target
            text. z-20 so it sits above the sticky column header (z-10).
            Without this, when a row is positioned at the very top of the
            scroll container, the sticky header's stacking context wins (rows
            are position:relative with auto z-index, so the row's local z-10
            doesn't escape the sticky header's z-10 context). */}
        <div className="pointer-events-none absolute right-2 top-0.5 z-20 flex">
          <div className="pointer-events-auto">
            <CellActionRail
              revealed={railRevealed}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((p) => !p)}
              alwaysShowChevron
              expansionAttentionDot={chevronAttentionDot}
            >
              {/* Always-visible #1: AI Generate */}
              <RailButton
                icon={<Sparkles className="h-3.5 w-3.5" />}
                tooltip={
                  isAnonymous
                    ? "Sign in for AI translations"
                    : !editable
                      ? "Read-only (imported from git)"
                      : !isCompletionConfigured
                        ? "Set up AI to enable"
                        : !isCompletionAvailable
                          ? "AI service unavailable — try again shortly"
                          : isLoading
                            ? "Generating…"
                            : "Translate with AI"
                }
                onClick={() => {
                  if (isLoading) return
                  if (!isCompletionConfigured && editable && !isAnonymous) {
                    onAiSetupNeeded?.()
                    return
                  }
                  if (
                    isCompletionConfigured &&
                    isCompletionAvailable &&
                    editable &&
                    !isAnonymous
                  ) {
                    // FRO-278: if the cell already has human text, confirm
                    // before letting the AI overwrite it. Empty cells proceed
                    // immediately (byte-identical to previous behavior).
                    if (cell.translated.trim()) {
                      setShowGenerateConfirm(true)
                    } else {
                      onCompleteSingle(cell)
                    }
                  }
                }}
                disabled={
                  (!isCompletionConfigured && !onAiSetupNeeded) ||
                  !isCompletionAvailable ||
                  !editable ||
                  isAnonymous ||
                  isLoading
                }
                pulsing={isLoading}
                onMouseDown={onDragStart}
                onMouseEnter={onDragEnter}
              />

              {/* FRO-237: Direct mic button on the rail when no audio — one-click
                  action without needing to open a popover ("just hit the record
                  mic — quick action"). Replaces the redundant Record item inside
                  the ⋯ popover. When audio IS present, FRO-236's Play icon on
                  the overflow button already gives a direct play affordance.
                  WARN fix: the button must NOT be disabled when micDenied —
                  disabled elements receive no mouse events, so the "click for
                  help" affordance is unreachable. Instead keep it enabled and
                  route clicks to the denied-help popover. */}
              {!hasAudio && onOpenRecording && editable && (() => {
                const unsupportedReason = getUnsupportedReason()
                const isUnsupported = unsupportedReason !== null
                const micTooltip = micDenied
                  ? "Microphone access blocked — click for help"
                  : isUnsupported
                    ? `Recording unavailable — ${unsupportedReason}`
                    : "Record audio"
                return (
                  <div className="relative">
                    <RailButton
                      icon={<Mic className="h-3.5 w-3.5" />}
                      tooltip={micTooltip}
                      onClick={() => {
                        if (micDenied) { setShowMicDeniedHelp((v) => !v); return }
                        if (!isUnsupported) onOpenRecording(cell.id)
                      }}
                      toneClass={
                        micDenied
                          ? "text-amber-500/70 hover:text-amber-500"
                          : isUnsupported
                            ? "cursor-not-allowed text-muted-foreground/30"
                            : undefined
                      }
                      // NEVER disable when micDenied — that kills mouse events
                      // and makes the help popover unreachable.
                      disabled={isUnsupported && !micDenied}
                    />
                    {/* Mic-denied help popover — replicates CellAudioRecordButton's
                        pattern so behaviour is consistent across the two surfaces. */}
                    {micDenied && showMicDeniedHelp && (
                      <span
                        role="tooltip"
                        className="absolute bottom-full right-0 z-50 mb-1 w-52 rounded-md border bg-popover px-3 py-2 text-[11px] leading-snug text-popover-foreground shadow-md"
                      >
                        <strong className="block font-semibold">Microphone blocked</strong>
                        <span className="mt-0.5 block text-muted-foreground">
                          Open your browser&apos;s site settings (🔒 in the address bar) and allow microphone access, then reload the page.
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowMicDeniedHelp(false)}
                          className="mt-1.5 text-[10px] underline text-muted-foreground hover:text-foreground"
                        >
                          Dismiss
                        </button>
                      </span>
                    )}
                  </div>
                )
              })()}

              {hasAudio && (
                <RailButton
                  icon={
                    audioController.isPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )
                  }
                  tooltip={audioController.isPlaying ? "Pause" : "Play audio"}
                  onClick={() => {
                    if (audioController.state === "loading") return
                    if (audioController.isPlaying) audioController.pause()
                    else void audioController.play()
                  }}
                  disabled={audioController.state === "loading"}
                  toneClass={
                    audioController.isPlaying
                      ? "text-primary hover:text-primary"
                      : undefined
                  }
                  dot="emerald"
                />
              )}

              {cell.translated.trim().length > 0 && (
                <CellTtsButton
                  cellId={cell.id}
                  text={cell.translated}
                  original={cell.original}
                  context={cell.context}
                  cellLabel={cell.cellLabel}
                  sourceLanguage={project.sourceLanguage}
                  targetLanguage={project.targetLanguage}
                  projectTtsSettings={project.ttsSettings}
                  cellTtsSettings={cell.ttsSettings}
                  generatedVoiceAudioId={cell.selectedGeneratedVoiceAudioId}
                  attachments={cell.attachments}
                  projectId={project.id}
                  fileId={cell.fileId}
                  disabled={!editable}
                  playOnly
                />
              )}

              {editable && !isLoading && (
                <RailButton
                  icon={<NotebookPen className="h-3.5 w-3.5" />}
                  tooltip="Add footnote"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    captureFootnoteAnchor()
                  }}
                  onClick={() => openAddFootnoteDialog()}
                />
              )}

              {onOpenComments && (
                <RailButton
                  icon={<MessageCircle className="h-3.5 w-3.5" />}
                  tooltip={
                    openCommentCount > 0
                      ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}`
                      : "Add comment"
                  }
                  onClick={() => onOpenComments(cell.id)}
                  toneClass={
                    openCommentCount > 0
                      ? "text-primary hover:text-primary"
                      : undefined
                  }
                  dot={openCommentCount > 0 ? "primary" : undefined}
                />
              )}

              {onSeekToCue && (
                <RailButton
                  icon={<Play className="h-3.5 w-3.5" />}
                  tooltip="Play from this cue"
                  onClick={() => onSeekToCue(cell.id)}
                />
              )}
            </CellActionRail>
          </div>
        </div>
      </div>

      {/* Expansion panel — hosts the rich, lower-frequency context that used
          to clutter the inline row: health breakdown, backtranslation, audio
          waveform + transcript, infractions detail, edit history. Indented to
          align under the content columns (past the gutter) so it reads as the
          row's child, and only mounted while open so collapsed rows stay flush. */}
      {expanded && (
      <div className="pl-[3.75rem] pr-4 pb-2">
        <CellExpansion
          open={expanded}
          tab={expansionTab}
          onTabChange={setExpansionTab}
          onClose={() => setExpanded(false)}
          tabs={[
            {
              value: "health",
              icon: <Activity className="h-3 w-3" />,
              label: "Staleness",
              content: (
                <div className="space-y-1.5 py-3 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">{cell.endorsementCount ?? 0}</span>
                    {" "}endorsement{(cell.endorsementCount ?? 0) === 1 ? "" : "s"} · health{" "}
                    <span className="font-medium text-foreground">{healthValue}%</span>
                  </p>
                  <p>
                    {cellNeedsAttention
                      ? "Needs attention — nearby context cells haven't been validated yet."
                      : "No attention needed — enough nearby context is validated."}
                  </p>
                </div>
              ),
            },
            {
              value: "backtranslation",
              icon: <FileText className="h-3 w-3" />,
              label: "Back-translation",
              attentionDot: isBtStale ? "amber" : undefined,
              content: (
                <div className="flex flex-col gap-2.5">
                  {/* ── Header: a calm label + a quiet explainer. The controls
                      stay subdued so the reading below is the focus, not the
                      buttons. ─────────────────────────────────────────────── */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">Back-translation</span>
                      <AppTooltip content="A plain reading of your translation back in your reference language. Use it to check the meaning carried over.">
                        <Info className="h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                      </AppTooltip>
                    </div>
                    {/* Controls appear only when there's a reading to act on. */}
                    {cell.backtranslation && !btEditing && (
                      <div className="flex items-center gap-0.5">
                        {/* Refine — replaces the old "Polish"/"statistical" jargon.
                            On = AI-refined wording; off = plain word-for-word.
                            Toggling regenerates so the text matches the mode. */}
                        {editable && (
                          <AppTooltip content={
                            !isBacktranslationConfigured
                              ? "Add an AI model in project settings to refine the wording"
                              : btPolishOn
                                ? "Refined with AI — turn off for a plain word-for-word reading"
                                : "Refine the wording with AI for a more natural reading"
                          }>
                            <button
                              type="button"
                              disabled={!isBacktranslationConfigured || isBacktranslating}
                              onClick={() => {
                                const next = !btPolishOn
                                setBtPolishOn(next)
                                onBacktranslate?.(cell, next)
                              }}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                                btPolishOn
                                  ? "bg-violet-500/12 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300"
                                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                              )}
                            >
                              <Sparkles className={cn("h-3 w-3", isBacktranslating && btPolishOn && "animate-pulse")} />
                              Refine
                            </button>
                          </AppTooltip>
                        )}
                        {/* Edit — contributor+ only. A quiet icon, not a labelled pill. */}
                        {editable ? (
                          <AppTooltip content="Edit the back-translation">
                            <button
                              type="button"
                              onClick={handleBtEditStart}
                              aria-label="Edit the back-translation"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </AppTooltip>
                        ) : (
                          <AppTooltip content="Contributor+ required to edit back-translations">
                            <span
                              aria-label="Contributor+ required to edit back-translations"
                              className="inline-flex h-6 w-6 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground opacity-40"
                            >
                              <Pencil className="h-3 w-3" />
                            </span>
                          </AppTooltip>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Body ────────────────────────────────────────────────── */}
                  {cell.translated.trim().length === 0 ? (
                    <div className="flex flex-col items-center gap-1.5 rounded-xl bg-muted/40 px-3 py-6 text-center">
                      <FileText className="h-4 w-4 text-muted-foreground/40" />
                      <p className="text-xs text-muted-foreground">Translate this cell to read it back.</p>
                    </div>
                  ) : cell.backtranslation ? (
                    <>
                      {/* Stale: one warm nudge with the fix inline — not a
                          separate warning pill plus a separate button. */}
                      {isBtStale && (
                        <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-500/[0.08] px-3 py-1.5">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            Your translation changed since this was written
                          </span>
                          <button
                            type="button"
                            onClick={() => onBacktranslate?.(cell, btPolishOn)}
                            disabled={isBacktranslating || cell.translated.trim().length === 0}
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 transition-colors hover:bg-amber-500/25 dark:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                            Refresh
                          </button>
                        </div>
                      )}
                      {btEditing ? (
                        /* Inline editor */
                        <div className="flex flex-col gap-1.5">
                          <textarea
                            autoFocus
                            value={btEditValue}
                            onChange={(e) => setBtEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") handleBtCancel()
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBtSave()
                            }}
                            rows={3}
                            className="w-full resize-none rounded-lg border border-border bg-background px-3.5 py-3 text-[15px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
                          />
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={handleBtCancel}
                              className="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={handleBtSave}
                              disabled={btSaving || !btEditValue.trim()}
                              className="rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {btSaving ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* The reading — the hero. Foreground, comfortable size
                           and leading, in a soft well with a gentle tone bar
                           (rhymes with the recording's transcript). */
                        <div className="relative overflow-hidden rounded-xl bg-muted/50 py-3 pr-4 pl-4">
                          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-full bg-primary/35" />
                          <p className="text-[15px] leading-relaxed text-foreground/90">
                            {cell.backtranslation}
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    /* No reading yet — friendly, with one clear primary. */
                    <div className="flex flex-col items-center gap-2.5 rounded-xl bg-muted/40 px-3 py-6 text-center">
                      <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground">
                        See what your translation says when read back, so you can check the meaning carried over.
                      </p>
                      <button
                        type="button"
                        onClick={() => onBacktranslate?.(cell, btPolishOn)}
                        disabled={isBacktranslating || cell.translated.trim().length === 0}
                        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isBacktranslating ? (
                          <><RefreshCw className="h-3 w-3 animate-spin" /> Reading it back…</>
                        ) : (
                          <><Sparkles className="h-3 w-3" /> Read it back</>
                        )}
                      </button>
                    </div>
                  )}
                  {/* ── FRO-207: Interlinear alignment panel ──────────────── */}
                  {alignmentModelForExpansion && cell.original.trim() && cell.translated.trim() && (
                    <InterlinearAlignmentPanel
                      sourceText={cell.original}
                      targetText={cell.translated}
                      alignmentModel={alignmentModelForExpansion}
                      confirmedSeeds={project.alignmentSeeds ?? []}
                      onSeedChange={onAlignmentSeedChange ?? (() => undefined)}
                    />
                  )}
                  {backtranslationError && (
                    <p className="text-xs text-destructive">{backtranslationError}</p>
                  )}
                </div>
              ),
            },
            ...(showFootnotesInExpansion ? [{
              value: "footnotes",
              icon: <NotebookPen className="h-3 w-3" />,
              label: "Footnotes",
              content: (
                <FootnoteInline
                  sourceFootnotes={sourceDetailFootnotes}
                  targetFootnotes={allFootnotes.targetFootnotes}
                  editable={editable}
                  isDocx={isDocxFile}
                  onSave={(footnoteIndex, newText) => {
                    const updated = spliceFootnoteText(cell.translated ?? "", footnoteIndex, newText)
                    handleEditorCommit({ value: updated, valueHtml: updated })
                  }}
                  onDelete={(footnoteIndex) => {
                    const updated = deleteFootnote(cell.translated ?? "", footnoteIndex)
                    handleEditorCommit({ value: updated, valueHtml: updated })
                  }}
                  onCreateTarget={handleCreateTargetFootnote}
                  numberOffset={targetFootnoteNumberOffset}
                  activeFootnoteIndex={activeFootnoteIndex}
                  compact
                />
              ),
            }] : []),
            {
              value: "audio",
              icon: <Mic className="h-3 w-3" />,
              label: "Recording",
              attentionDot: transcriptNeedsAttention
                ? "amber"
                : (hasAudio || hasGeneratedVoice)
                  ? "emerald"
                  : undefined,
              content: (
                <div
                  className={cn(
                    "flex flex-col gap-3 rounded-xl transition-colors",
                    dragOverVoiceId && "bg-primary/10 ring-2 ring-primary/40",
                  )}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(VOICE_ASSIGN_MIME)) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = "copy"
                      const voiceId = e.dataTransfer.getData(VOICE_ASSIGN_MIME)
                      if (voiceId && voiceId !== dragOverVoiceId) setDragOverVoiceId(voiceId)
                    }
                  }}
                  onDragLeave={() => setDragOverVoiceId(null)}
                  onDrop={(e) => {
                    const voiceId = e.dataTransfer.getData(VOICE_ASSIGN_MIME)
                    setDragOverVoiceId(null)
                    if (voiceId && onAssignVoice) {
                      e.preventDefault()
                      onAssignVoice(cell.id, voiceId)
                    }
                  }}
                >
                  {dragOverVoiceId && (
                    <div className="flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 py-2 text-xs font-medium text-primary">
                      {(() => {
                        const v = audioLens?.voices.find(vv => vv.id === dragOverVoiceId)
                        return v ? `Synthesize with ${v.name}` : "Drop to synthesize"
                      })()}
                    </div>
                  )}
                  {hasAudio ? (
                    <>
                      <div className="flex items-center gap-2">
                        <CellAudioButton controller={audioController} />
                        <div className="flex-1">
                          <CellWaveform
                            controller={audioController}
                            height={36}
                            strategy={project.audioMediaStrategy ?? "lazy"}
                          />
                        </div>
                      </div>
                      {cellAudioTimings && cellAudioTimings.length > 0 && (
                        <CellTranscriptPreview
                          ref={transcriptPreviewRef}
                          timings={cellAudioTimings}
                          cellText={cell.translated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(cell.translated).length === cellAudioTimings.length
                          }
                          editable={editable}
                          onRetranscribe={handleTranscribe}
                          onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                        />
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Re-record
                        </button>
                        <button
                          type="button"
                          onClick={handleTranscribe}
                          disabled={!editable || isTranscribing}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Sparkles
                            className={cn(
                              "h-3 w-3",
                              isTranscribing && "animate-pulse",
                            )}
                          />
                          {isTranscribing ? "Transcribing…" : "Transcribe"}
                        </button>
                        {/* Surfaces model-download %, failures (click-to-expand
                            with Retry), and a success flash. Errors previously
                            existed in transcribe-status but were rendered
                            nowhere — the button just reverted to "Transcribe". */}
                        <CellTranscribeBadge
                          audioId={cell.selectedAudioId}
                          hasTimings={(cellAudioTimings?.length ?? 0) > 0}
                          onJumpToTranscript={() => transcriptPreviewRef.current?.scrollIntoView({ block: "nearest" })}
                          onRetry={handleTranscribe}
                        />
                        {cell.selectedAudioId && selectedAudio && (
                          <DenoiseButton
                            projectId={project.id}
                            fileId={cell.fileId}
                            cellId={cell.id}
                            selectedAudioId={cell.selectedAudioId}
                            selectedUrl={selectedAudio.url}
                            referenceAudioId={selectedAudio.referenceAudioId ?? null}
                            originalUrl={
                              selectedAudio.referenceAudioId
                                ? cell.attachments?.[selectedAudio.referenceAudioId]?.url ?? null
                                : null
                            }
                            originalDurationMs={
                              selectedAudio.referenceAudioId
                                ? cell.attachments?.[selectedAudio.referenceAudioId]?.durationMs ?? null
                                : null
                            }
                            author={username}
                            session={rowSession}
                            editable={editable}
                          />
                        )}
                      </div>
                    </>
                  ) : hasGeneratedVoice ? (
                    <>
                      <div className="flex items-center gap-2">
                        <CellAudioButton controller={generatedVoiceController} />
                        <div className="flex-1">
                          <CellWaveform
                            controller={generatedVoiceController}
                            height={36}
                            strategy={project.audioMediaStrategy ?? "lazy"}
                          />
                        </div>
                      </div>
                      {generatedVoiceTimings && generatedVoiceTimings.length > 0 && (
                        <CellTranscriptPreview
                          timings={generatedVoiceTimings}
                          cellText={cell.translated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(cell.translated).length === generatedVoiceTimings.length
                          }
                          editable={editable}
                          onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">AI generated voice. Drag a voice from the toolbar to regenerate, or:</span>
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Record over
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/50">
                        <Mic className="h-5 w-5" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        No audio yet. Record below, or drag a voice onto this cell from the toolbar above.
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Record
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ),
            },
            {
              value: "issues",
              icon: <AlertTriangle className="h-3 w-3" />,
              label: "Issues",
              attentionDot:
                cellInfractions.length > 0
                  ? hasMajorInfraction
                    ? "red"
                    : "amber"
                  : undefined,
              disabled: cellInfractions.length === 0 && waivedInfractions.length === 0,
              content: (
                <div className="flex flex-col gap-1.5">
                  {cellInfractions.length === 0 && waivedInfractions.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No translation rule issues on this cell.
                    </p>
                  ) : (
                    <>
                      {cellInfractions.map((inf) => {
                        const rule = ruleMap.get(inf.ruleId)
                        const isMajor = rule?.severity === "major"
                        const Icon = isMajor ? AlertTriangle : AlertCircle
                        return (
                          <button
                            key={inf.ruleId}
                            type="button"
                            onClick={() => setOpenRuleId(inf.ruleId)}
                            className="bg-card flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-all"
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 h-3 w-3 shrink-0",
                                isMajor ? "text-red-500" : "text-amber-500",
                              )}
                            />
                            <span className="flex-1">
                              <span className="font-medium text-foreground">
                                {rule?.name ?? inf.ruleId}
                              </span>
                              <span className="ml-1 text-muted-foreground">
                                — {inf.message}
                              </span>
                            </span>
                            <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
                          </button>
                        )
                      })}
                      {waivedInfractions.length > 0 && (
                        <>
                          <div className="mt-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Waived
                          </div>
                          {waivedInfractions.map((inf) => {
                            const rule = ruleMap.get(inf.ruleId)
                            return (
                              <button
                                key={`waived-${inf.ruleId}`}
                                type="button"
                                onClick={() => setOpenRuleId(inf.ruleId)}
                                className="bg-muted flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground/70 transition-all"
                              >
                                <Check className="mt-0.5 h-3 w-3 shrink-0" />
                                <span className="flex-1">
                                  {rule?.name ?? inf.ruleId}
                                </span>
                              </button>
                            )
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              ),
            },
            {
              value: "history",
              icon: <HistoryIcon className="h-3 w-3" />,
              label: "History",
              content: (
                <div className="flex flex-col gap-2">
                  {isHistoryLoading ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      Loading edit history…
                    </p>
                  ) : isHistoryError ? (
                    <p className="py-3 text-center text-xs text-destructive">
                      Failed to load edit history.
                    </p>
                  ) : fetchedHistory.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No edit history yet.
                    </p>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onOpenHistory?.(cell.id)}
                        disabled={!onOpenHistory}
                        className="self-start inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-all disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <HistoryIcon className="h-3 w-3" />
                        Open full history
                      </button>
                      <ul className="bg-muted divide-y divide-border/40 rounded-lg">
                        {[...fetchedHistory].slice(-5).reverse().map((entry, i) => {
                          const date = new Date(entry.timestamp).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                          return (
                            <li key={`${entry.timestamp}-${i}`} className="px-2.5 py-1.5 text-xs">
                              <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                                <span>{entry.author}</span>
                                <span>{date}</span>
                              </div>
                              <div className="mt-0.5 text-muted-foreground">
                                <FootnotedTextValue value={entry.value} showFootnotes />
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
      )}

      {openRuleId && (() => {
        const inf = [...cellInfractions, ...waivedInfractions].find(
          (i) => i.ruleId === openRuleId,
        )
        const rule = ruleMap.get(openRuleId)
        if (!inf || !rule) return null
        return (
          <ViolationPopover
            open
            onOpenChange={(next) => {
              if (!next) {
                setOpenRuleId(null)
                setOpenRuleAnchor(null)
              }
            }}
            infraction={inf}
            ruleName={rule.name}
            waivers={cell.waivers ?? []}
            anchor={openRuleAnchor}
            onOpenRule={(ruleId) => {
              setOpenRuleId(null)
              setOpenRuleAnchor(null)
              onInfractionClick?.(ruleId)
            }}
            onWaive={handleWaive}
            onUnwaive={handleUnwaive}
          />
        )
      })()}

      {/* Add-from-selection confirm dialog (FRO-260). Mounted per-row so it
          is scoped to the cell whose selection triggered it. */}
      {onAddConceptFromSelection && (
        <AddConceptDialog
          open={showAddConceptDialog}
          sourceTerm={sourceSelection ?? ""}
          onConfirm={handleAddConceptConfirm}
          onCancel={handleAddConceptCancel}
        />
      )}

      {/* FRO-278: confirm before AI Generate overwrites non-empty cell. */}
      <GenerateOverwriteDialog
        open={showGenerateConfirm}
        isValidated={cell.status === "validated"}
        onConfirm={() => {
          setShowGenerateConfirm(false)
          onCompleteSingle(cell)
        }}
        onCancel={() => setShowGenerateConfirm(false)}
      />

      <AddFootnoteDialog
        open={addFootnoteOpen}
        defaults={addFootnoteDefaults}
        onOpenChange={(open) => {
          setAddFootnoteOpen(open)
          if (!open) pendingFootnoteAnchorRef.current = null
        }}
        onAdd={handleAddFootnote}
      />

    </div>
  )
}

// ---------------------------------------------------------------------------
// FRO-278 — GenerateOverwriteDialog
// ---------------------------------------------------------------------------
// Lightweight confirm dialog shown when the user clicks AI Generate on a cell
// that already contains human-authored text. The copy is escalated when the
// cell has been validated so the expert understands validation will be cleared.
//
// Cancel semantics: nothing is committed, no completion is triggered. The user
// returns to the cell in its current state. We chose "never start" over
// "start-then-discard" because an in-progress stream would occupy the cell's
// "generating" state and confuse the UX on cancel.
// ---------------------------------------------------------------------------

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface GenerateOverwriteDialogProps {
  open: boolean
  /** True when cell.status === "validated" — escalates the dialog copy. */
  isValidated: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function GenerateOverwriteDialog({
  open,
  isValidated,
  onConfirm,
  onCancel,
}: GenerateOverwriteDialogProps) {
  const title = isValidated
    ? "Replace validated translation?"
    : "Replace existing translation?"

  const description = isValidated
    ? "This cell is validated — replacing it clears the validation. The current text is preserved in cell history and can be recovered."
    : "Replace the existing translation? The current text is preserved in cell history and can be recovered."

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="gen-overwrite-title" aria-describedby="gen-overwrite-desc">
        <DialogHeader>
          <DialogTitle id="gen-overwrite-title">{title}</DialogTitle>
          <DialogDescription id="gen-overwrite-desc">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
