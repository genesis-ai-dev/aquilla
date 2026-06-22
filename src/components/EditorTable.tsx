import React, { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import DOMPurify from "dompurify"
import {
  Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, RefreshCw,
  MessageCircle, Play, Pause, Mic, Sparkles, FileText, History as HistoryIcon,
  ArrowRight, Activity, Loader2, MoreHorizontal,
} from "lucide-react"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import { getCellPref, setCellPref } from "@/lib/store/audio-cell-prefs"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord, Voice, ProjectTtsSettings, OrderedBy } from "@/lib/parsers/types"
import { sortByLens, hasTiming } from "@/lib/timeline/derive"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { emitTargetCellCommit, emitCellValidate, emitCellUnvalidate, emitCellWaive, emitCellUnwaive } from "@/lib/sync/events-emit"
import { ExamplePanel } from "./ExamplePanel"
import { HighlightedText, buildHighlightsFromExamples } from "./HighlightedText"
import { needsAttention, resolveDecayConfig } from "@/lib/health/decay-engine"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { StaleSourceIndicator } from "./StaleSourceIndicator"
import { HealthRing } from "./HealthRing"
import { TranslatedEditor } from "./TranslatedEditor"
import { CellWaveform } from "./CellWaveform"
import { CellAudioButton } from "./CellAudioButton"
import { CellTtsButton } from "./CellTtsButton"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellActionRail, RailButton, isInteractiveTarget } from "./CellActionRail"
import { CellExpansion } from "./CellExpansion"
import { tokenizeWords } from "@/lib/audio/timings"
import { useCellAudio } from "@/hooks/useCellAudio"
import { useCellEditHistory } from "@/hooks/useCellEditHistory"
import { setTranscribeStatus, useTranscribeStatus } from "@/lib/audio/transcribe-status"
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
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { CellNumberPill } from "./cell/CellNumberPill"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import { CellVoicePanel } from "./cell/CellVoicePanel"
import { CellAudioRecordButton } from "./CellAudioRecordButton"
import { useMicPermission } from "@/hooks/useMicPermission"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { isPerfLogEnabled } from "@/lib/perf-log"
import { partitionInfractions } from "@/lib/rules/waivers"
import { ViolationPopover } from "./ViolationPopover"
import { VOICE_ASSIGN_MIME } from "./VoiceLibraryPanel"
import type { RangeHighlight } from "./HighlightedText"
import { TermLookupPopover } from "./TermLookupPopover"
import type { Concept } from "@/lib/terminology/types"

// Per-row render counter. Always accumulated when perf logging is on (cheap)
// but NOT auto-logged — render logs would flood the console and push the
// useful health/cells/worker logs out of the 500-entry buffer. Inspect on
// demand from the console:
//
//   window.__perfRowRenders         → Map of "cellIdPrefix" → count
//   window.__perfDumpRowRenders()   → console.table of the same
const rowRenders = new Map<string, number>()
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
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
        title={isTranslating ? "Translating before voicing" : pct != null ? `Loading voice model (${pct}%)` : "Loading voice model"}
      >
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
        {isTranslating
          ? "Translating"
          : pct != null
            ? <>Loading <span className="tabular-nums">{pct}%</span></>
            : "Loading"}
      </span>
    )
  }
  if (status.kind === "synthesizing") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary"
        title="Generating audio…"
      >
        <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
        Voicing
      </span>
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
        <span
          title="Audio generation failed — click Generate to retry"
          className="inline-flex max-w-[80px] cursor-default items-center gap-1 truncate rounded-full bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
        >
          Not voiced
        </span>
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
            title={error.category === "missing-gemini-key"
              ? "Audio needs an API key — click to open audio settings"
              : `Audio failed: ${error.title}`}
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
const SELECTION_DRAG_THRESHOLD_PX = 3
const SELECTION_EDGE_SCROLL_ZONE_PX = 56
const SELECTION_EDGE_SCROLL_STEP_PX = 22

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
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
  /** Called after a successful `target.cell.commit` enqueue so the parent
   *  refetches the cells projection. */
  onCellCommitted?: () => void | Promise<void>
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
  /** FRO-174: Accept the queued completion preview (Tab). Writes the cell. */
  onAcceptCompletion?: (cell: CellData) => Promise<void>
  /** FRO-174: Reject the queued completion preview (Esc). No write. */
  onRejectCompletion?: (cellId: string) => void
  healthMap: Map<string, number>
  infractions?: Map<string, RuleInfraction[]>
  rules?: TranslationRule[]
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  onBacktranslate?: (cell: CellData) => void
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  /** Called when user saves a BT edit. Parent emits `cell.backtranslation.set`. */
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  cellOpenCommentCount?: Map<string, number>
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  /** Called when user clicks a disabled sparkle while AI is not yet configured. */
  onAiSetupNeeded?: () => void
  /** Called when the user clicks the mic button on a cell. The parent owns
   *  the recording modal so it can persist across cell navigation. */
  onOpenRecording?: (cellId: string) => void
  /** Re-read the project record from IDB after a settings change (e.g. voice library edits). */
  onProjectChanged?: () => void
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
  /** FRO-207: Pre-built interlinear alignment model for source↔target token
   *  alignment in the BT expansion tab. Built by ProjectWorkspace from all
   *  project cell pairs + persisted seeds. Optional — panel hides when absent. */
  alignmentModel?: import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when the user confirms or invalidates an alignment seed.
   *  Parent persists via project-settings and rebuilds the model. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cells, username, isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors, previews,
  onCompleteSingle, onCompleteBatch, onAcceptCompletion, onRejectCompletion, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  onSaveBacktranslation,
  cellOpenCommentCount, onOpenComments, onOpenHistory,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection,
  isAnonymous, onJumpToCell, onAiSetupNeeded, onOpenRecording,
  audioLens, onOpenAudioSetup,
  orderedBy,
  onProjectChanged, onAssignVoice,
  onCellCommitted,
  onOptimisticEdit,
  cellLockHolders,
  cellsWithRemoteChange,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  staleCellIds,
  getTokenForFile,
  alignmentModel,
  onAlignmentSeedChange,
}, ref) {
  const permissions = useProjectPermissions(project)
  const canEdit = permissions.canEditContent
  // Probe mic permission once (shared across all rows) so the help affordance
  // on CellAudioRecordButton activates when the user has blocked the mic.
  const { micDenied } = useMicPermission(audioLens !== null)
  const parentRef = useRef<HTMLDivElement>(null)
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
  const cellsWithAudio = useMemo(() => {
    if (audioByCellId.size === 0) return cells
    return cells.map((c) => {
      const entry = audioByCellId.get(c.id)
      if (!entry) return c
      const attachments: Record<string, CodexCellAttachment> = {}
      for (const [audioId, a] of Object.entries(entry.attachments)) {
        attachments[audioId] = {
          url: a.url,
          type: "audio",
          ...(a.voiceId ? { voiceId: a.voiceId } : {}),
          ...(a.referenceAudioId ? { referenceAudioId: a.referenceAudioId } : {}),
          ...(a.durationMs != null ? { durationMs: a.durationMs } : {}),
        }
      }
      return {
        ...c,
        attachments,
        selectedAudioId: entry.selectedAudioId ?? undefined,
        selectedGeneratedVoiceAudioId: entry.selectedGeneratedVoiceAudioId ?? undefined,
        audioTimings: entry.audioTimings as Record<string, WordTiming[]>,
      }
    })
  }, [cells, audioByCellId])

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

  const virtualizer = useVirtualizer({
    count: displayCells.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 90,
  })

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < cells.length) {
        virtualizer.scrollToIndex(index, { align: "center" })
      }
    },
    getCurrentIndex: () => 0,
    flashCell(cellId, _searchTerm) {
      // Defer to next frame: the virtualizer may still be scrolling, so the
      // DOM node we want might not exist yet.
      requestAnimationFrame(() => {
        const root = parentRef.current
        if (!root) return
        const el = root.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`)
        if (!el) return
        el.classList.add("codex-search-flash")
        window.setTimeout(() => el.classList.remove("codex-search-flash"), 1800)
      })
    },
  }), [virtualizer, cells.length])

  const clampCellIndex = useCallback((index: number) => {
    const last = cellsRef.current.length - 1
    if (last < 0) return -1
    return Math.max(0, Math.min(last, index))
  }, [])

  const findCellIndex = useCallback((cellId: string | null | undefined) => {
    if (!cellId) return -1
    return cellsRef.current.findIndex((c) => c.id === cellId)
  }, [])

  // Move keyboard focus into the target editor at `index`, placing the caret
  // at the end. Scrolls the (virtualized) row into view first, then focuses on
  // the next frame once the DOM node exists. No-op if the index is out of range.
  const focusCellEditorByIndex = useCallback((index: number) => {
    const list = cellsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index].id
    virtualizer.scrollToIndex(index, { align: "center" })
    requestAnimationFrame(() => {
      const root = parentRef.current
      if (!root) return
      const pm = root.querySelector<HTMLElement>(
        `[data-cell-id="${CSS.escape(targetId)}"] .ProseMirror`,
      )
      if (!pm) return
      pm.focus()
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(pm)
        range.collapse(false) // collapse to end
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
  }, [virtualizer])

  // Resolve a navigation request from a cell editor (Up/Down/Tab) to the
  // adjacent cell and focus it. Out-of-range steps (top/bottom edge) no-op.
  const handleNavigateCell = useCallback((cellId: string, direction: "prev" | "next") => {
    const idx = findCellIndex(cellId)
    if (idx < 0) return
    focusCellEditorByIndex(direction === "next" ? idx + 1 : idx - 1)
  }, [findCellIndex, focusCellEditorByIndex])

  const selectRangeByIndexes = useCallback((anchorIndex: number, focusIndex: number) => {
    const list = cellsRef.current
    if (list.length === 0) return
    const anchor = clampCellIndex(anchorIndex)
    const focus = clampCellIndex(focusIndex)
    if (anchor < 0 || focus < 0) return

    const start = focus >= anchor
      ? anchor
      : Math.max(focus, anchor - MAX_SELECTED + 1)
    const end = focus >= anchor
      ? Math.min(focus, anchor + MAX_SELECTED - 1)
      : anchor
    const ids = list.slice(start, end + 1).map((c) => c.id)
    setSelection(ids, list[anchor]?.id ?? ids[0] ?? null)
  }, [clampCellIndex])

  const getIndexAtClientY = useCallback((clientY: number) => {
    const scrollEl = parentRef.current
    const list = cellsRef.current
    if (!scrollEl || list.length === 0) return -1
    const rect = scrollEl.getBoundingClientRect()
    const yWithin = Math.max(0, Math.min(rect.height, clientY - rect.top))
    const y = scrollEl.scrollTop + yWithin
    const virtualItems = virtualizer.getVirtualItems()
    if (virtualItems.length === 0) return clampCellIndex(Math.round(y / 90))

    let nearest = virtualItems[0]
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const item of virtualItems) {
      const end = item.start + item.size
      if (y >= item.start && y <= end) return clampCellIndex(item.index)
      const distance = y < item.start ? item.start - y : y - end
      if (distance < nearestDistance) {
        nearest = item
        nearestDistance = distance
      }
    }
    return clampCellIndex(nearest.index)
  }, [clampCellIndex, virtualizer])

  const updateSelectionFromPointer = useCallback((clientY: number) => {
    const drag = selectionDragRef.current
    if (!drag) return
    const nextIndex = getIndexAtClientY(clientY)
    if (nextIndex < 0 || nextIndex === drag.lastIndex) return
    drag.lastIndex = nextIndex
    selectRangeByIndexes(drag.anchorIndex, nextIndex)
  }, [getIndexAtClientY, selectRangeByIndexes])

  const scrollSelectionNearEdge = useCallback((clientY: number) => {
    const scrollEl = parentRef.current
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    let delta = 0
    if (clientY < rect.top + SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = -SELECTION_EDGE_SCROLL_STEP_PX
    } else if (clientY > rect.bottom - SELECTION_EDGE_SCROLL_ZONE_PX) {
      delta = SELECTION_EDGE_SCROLL_STEP_PX
    }
    if (delta !== 0) scrollEl.scrollTop += delta
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
    const anchorIndex = findCellIndex(getSelectionAnchorId())
    const shouldRange =
      !isAdditive &&
      anchorIndex >= 0 &&
      (e.shiftKey || (selectedIds.size > 0 && !isAlreadySelected))
    const startIndex = shouldRange ? anchorIndex : rowIndex

    selectionDragRef.current = {
      pointerId: e.pointerId,
      anchorIndex: clampCellIndex(startIndex),
      lastIndex: clampCellIndex(rowIndex),
      startX: e.clientX,
      startY: e.clientY,
      didDrag: false,
    }
    selectionPointerYRef.current = e.clientY

    previousBodyUserSelectRef.current = document.body.style.userSelect
    document.body.style.userSelect = "none"

    const controller = new AbortController()
    selectionDragAbortRef.current = controller
    window.addEventListener("pointermove", handleSelectionPointerMove, {
      signal: controller.signal,
    })
    window.addEventListener("pointerup", handleSelectionPointerEnd, {
      signal: controller.signal,
    })
    window.addEventListener("pointercancel", handleSelectionPointerEnd, {
      signal: controller.signal,
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
      clearSelection()
    } else {
      setSelection([cellId], cellId)
    }
    startSelectionAutoScroll()
  }, [
    clampCellIndex,
    findCellIndex,
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

  return (
    <div ref={parentRef} className="h-full overflow-auto" onMouseUp={handleMouseUp}>
      <div className={cn("sticky top-0 z-10 grid gap-2 border-b border-border bg-background px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground", gridCols)}>
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

      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cell = displayCells[virtualRow.index]
          // The positioning wrapper lives OUTSIDE MemoizedRow. When the typed
          // cell grows in height, every row below it gets a new virtualRow.start
          // — if that value crossed the memo boundary, every shifted row would
          // re-render. Here the position-carrying div is a fresh element each
          // parent render (cheap), but MemoizedRow below it sees stable props.
          //
          // Timeline-segment-model: in the time lens, a segment with no timing
          // is kept in its sequence "home" but flagged — never given fake
          // timecodes ("fail loud"). Marked here on the wrapper so we don't
          // touch EditorRow internals.
          const untimedInTimeLens = isTimeOrdered && !hasTiming(cell)
          return (
            <div
              key={cell.id}
              data-cell-id={cell.id}
              data-index={virtualRow.index}
              data-untimed={untimedInTimeLens ? "true" : undefined}
              ref={virtualizer.measureElement}
              title={untimedInTimeLens ? "No specific timing — ordered by sequence" : undefined}
              className={cn(untimedInTimeLens && "border-l-2 border-dashed border-amber-400/70")}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {untimedInTimeLens && (
                <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-amber-400/15 px-1 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  no timing
                </span>
              )}
              <MemoizedRow
                project={project}
                cell={cell}
                isStaleSource={staleCellIds?.has(cell.id) ?? false}
                username={username}
                editable={canEdit}
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
                onAcceptCompletion={onAcceptCompletion}
                onRejectCompletion={onRejectCompletion}
                onInfractionClick={onInfractionClick}
                isBacktranslationConfigured={isBacktranslationConfigured}
                backtranslating={backtranslating}
                backtranslationErrors={backtranslationErrors}
                onBacktranslate={onBacktranslate}
                onSaveBacktranslation={onSaveBacktranslation}
                cellOpenCommentCount={cellOpenCommentCount}
                onOpenComments={onOpenComments}
                onOpenHistory={onOpenHistory}
                activeCueIndex={activeCueIndex}
                onSeekToCue={onSeekToCue}
                rowIndex={virtualRow.index}
                lineNumbersEnabled={lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                sourceTextDirection={sourceTextDirection}
                targetTextDirection={targetTextDirection}
                gridCols={gridCols}
                isAnonymous={isAnonymous}
                onJumpToCell={onJumpToCell}
                onAiSetupNeeded={onAiSetupNeeded}
                onOpenRecording={onOpenRecording}
                micDenied={micDenied}
                audioLens={audioLens ?? null}
                onOpenAudioSetup={onOpenAudioSetup}
                onProjectChanged={onProjectChanged}
                onAssignVoice={onAssignVoice}
                onDragStart={handleDragStart}
                onDragEnter={handleDragEnter}
                onSelectionPointerDown={handleSelectionPointerDown}
                onNavigateCell={handleNavigateCell}
                getVoiceTakeCells={getVoiceTakeCells}
                getTokenForFile={getTokenForFile}
                alignmentModel={alignmentModel}
                onAlignmentSeedChange={onAlignmentSeedChange}
              />
            </div>
          )
        })}
      </div>
      {isTimeOrdered && displayCells.length === 0 && (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          {audioLens
            ? "No media segments yet. Import an audio or video file, or record a take, to populate the media layer."
            : "No text segments in this file."}
        </div>
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
  username: string
  editable: boolean
  /** Phase 5 / AD-9: source has advanced since this target was last committed.
   *  Resolved once per file by the parent (membership look-up) so this prop
   *  is just a stable boolean — preserves the row's React.memo invariant. */
  isStaleSource: boolean
  onCellCommitted?: () => void | Promise<void>
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
  /** FRO-174: Accept/reject callbacks for completion previews. */
  onAcceptCompletion?: (cell: CellData) => Promise<void>
  onRejectCompletion?: (cellId: string) => void
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  onBacktranslate?: (cell: CellData) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  cellOpenCommentCount?: Map<string, number>
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
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
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  onAssignVoice?: (cellId: string, voiceId: string) => void
  onDragStart: (cellId: string) => void
  onDragEnter: (cellId: string) => void
  onSelectionPointerDown: (
    cellId: string,
    rowIndex: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => void
  onNavigateCell: (cellId: string, direction: "prev" | "next") => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** FRO-207: Pre-built interlinear alignment model. */
  alignmentModel?: import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when user confirms/invalidates an alignment. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, previews, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount,
    activeCueIndex, rowIndex, gridCols,
    onDragStart: onDragStartParent, onDragEnter: onDragEnterParent,
    onSelectionPointerDown: onSelectionPointerDownParent,
    onNavigateCell: onNavigateCellParent,
    getVoiceTakeCells,
    getTokenForFile,
    alignmentModel,
    onAlignmentSeedChange,
    project, username, editable, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle, onAcceptCompletion, onRejectCompletion, onInfractionClick,
    isBacktranslationConfigured, onBacktranslate, onSaveBacktranslation,
    onOpenComments, onOpenHistory,
    onSeekToCue, lineNumbersEnabled, cellLabelsEnabled,
    sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, onAiSetupNeeded, onOpenRecording, micDenied, onProjectChanged, onAssignVoice,
    audioLens, onOpenAudioSetup,
    onCellCommitted, onOptimisticEdit, lockHolderLabel, remoteChangedWhileFocused,
    onClaimCell, onReleaseCell, onAckRemoteChange,
    isStaleSource,
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
  const completionDone = completingState === "done"
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

  return (
    <div
      className={cn(
        // Outer wrapper is the virtualizer's MEASURED spacer. Rows are now a
        // flush, continuous list (Linear flat model), so there's no inset/gap
        // here — the row's own px-4 and its border-b divider do the work.
        // (Margins on absolutely-positioned virtual rows break measurement.)
      )}
    >
      <EditorRow
        project={project}
        cell={cell}
        username={username}
        editable={editable}
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
        completionDone={completionDone}
        onAcceptCompletion={onAcceptCompletion}
        onRejectCompletion={onRejectCompletion}
        onInfractionClick={onInfractionClick}
        isBacktranslationConfigured={isBacktranslationConfigured}
        isBacktranslating={isBacktranslating}
        backtranslationError={backtranslationError}
        onBacktranslate={onBacktranslate}
        onSaveBacktranslation={onSaveBacktranslation}
        openCommentCount={openCommentCount}
        onOpenComments={onOpenComments}
        onOpenHistory={onOpenHistory}
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
        onAiSetupNeeded={onAiSetupNeeded}
        onOpenRecording={onOpenRecording}
        micDenied={micDenied}
        audioLens={audioLens}
        onOpenAudioSetup={onOpenAudioSetup}
        onProjectChanged={onProjectChanged}
        onAssignVoice={onAssignVoice}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onSelectionPointerDown={handleSelectionPointerDown}
        onNavigateCell={handleNavigateCell}
        getVoiceTakeCells={getVoiceTakeCells}
        getTokenForFile={getTokenForFile}
        alignmentModel={alignmentModel}
        onAlignmentSeedChange={onAlignmentSeedChange}
        onCellCommitted={onCellCommitted}
        onOptimisticEdit={onOptimisticEdit}
        lockHolderLabel={lockHolderLabel}
        remoteChangedWhileFocused={remoteChangedWhileFocused}
        onClaimCell={onClaimCell}
        onReleaseCell={onReleaseCell}
        onAckRemoteChange={onAckRemoteChange}
      />
    </div>
  )
})

interface EditorRowProps {
  project: ProjectRecord
  cell: CellData
  username: string
  editable: boolean
  /** Phase 5 / AD-9 — true when the source has advanced since the last
   *  target commit. Renders a small warning badge next to the validation
   *  status. Computed once-per-file by the parent. */
  isStaleSource: boolean
  onCellCommitted?: () => void
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
  /** FRO-174: Whether the cell is in "done" state waiting for user accept/reject. */
  completionDone: boolean
  /** FRO-174: Accept the queued preview (Tab). */
  onAcceptCompletion?: (cell: CellData) => Promise<void>
  /** FRO-174: Reject the queued preview (Esc). */
  onRejectCompletion?: (cellId: string) => void
  onInfractionClick?: (ruleId: string) => void
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  onBacktranslate?: (cell: CellData) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  /** FRO-207: Pre-built interlinear alignment model. */
  alignmentModel?: import("@/lib/completion/interlinear").AlignmentModel | null
  /** FRO-207: Called when user confirms/invalidates an alignment. */
  onAlignmentSeedChange?: (seed: import("@/lib/completion/interlinear").AlignmentSeed) => void
  openCommentCount: number
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  isActiveCue?: boolean
  onSeekToCue?: (cellId: string) => void
  onDragStart: () => void
  onDragEnter: () => void
  onSelectionPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
  onNavigateCell: (direction: "prev" | "next") => void
  getVoiceTakeCells: (startIndex: number, count: number) => CellData[]
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  gridCols: "grid-cols-[44px_1fr_1fr]"
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  onAiSetupNeeded?: () => void
  onOpenRecording?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  onAssignVoice?: (cellId: string, voiceId: string) => void
  getTokenForFile?: (fileId: string) => Promise<string | null>
}

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
}

function SourceWithTermLookup({
  text,
  highlights,
  ranges,
  showEvidence,
  onRangeClick,
  concepts,
  onTermApply,
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
  if (activeConcepts.length === 0) {
    return (
      <div className="text-sm">
        <HighlightedText
          text={text}
          highlights={highlights}
          ranges={ranges}
          showEvidence={showEvidence}
          onRangeClick={onRangeClick}
        />
      </div>
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

  return (
    <div className="text-sm">
      {parts}
    </div>
  )
}

function EditorRow({
  project, cell, username, editable, isCompletionConfigured, isCompletionAvailable, isLoading,
  completionPreview, loadingPhase, completionDone, onAcceptCompletion, onRejectCompletion,
  cellExamples, highlights, error, health,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle, onInfractionClick,
  isBacktranslationConfigured: _isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate, onSaveBacktranslation,
  openCommentCount, onOpenComments, onOpenHistory,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter, onSelectionPointerDown, onNavigateCell,
  rowIndex, lineNumbersEnabled, cellLabelsEnabled, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, onAiSetupNeeded, onOpenRecording, micDenied,
  audioLens, onOpenAudioSetup, onAssignVoice,
  onCellCommitted, onOptimisticEdit, lockHolderLabel, remoteChangedWhileFocused,
  onClaimCell, onReleaseCell, onAckRemoteChange,
  isStaleSource,
  getTokenForFile,
  alignmentModel,
  onAlignmentSeedChange,
}: EditorRowProps) {
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [openRuleAnchor, setOpenRuleAnchor] = useState<HTMLElement | null>(null)
  const [examplesExpanded, setExamplesExpanded] = useState(false)
  // FRO-204: chip click state for TermLookupPopover on target editor chips.
  const [termChipState, setTermChipState] = useState<{ term: string; anchor: HTMLElement } | null>(null)
  // Track whether the target editor has a non-empty text selection when a chip is clicked.
  const targetHasSelectionRef = useRef(false)
  const pendingTargetEventIdRef = useRef<string | null>(cell.targetEventId ?? null)
  /** voice-chip drag-over state: the voiceId being dragged over this cell's audio area */
  const [dragOverVoiceId, setDragOverVoiceId] = useState<string | null>(null)

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
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn("[waive] emit failed:", err)
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
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn("[unwaive] emit failed:", err)
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

  // Phase 2c-β: target-side rendering of violations happens via the
  // ProseMirror plugin inside TranslatedEditor, so we no longer compute
  // textarea-overlay ranges. Source-side ranges still flow through
  // HighlightedText below.
  void waivedRuleIds; void cellInfractions; void waivedInfractions; void ruleSeverity

  // Editor commit path. The plain TipTap editor (TranslatedEditor) calls
  // this on idle/blur/release with the current `{value, valueHtml}` snapshot.
  // We emit a `target.cell.commit` event chained off cell.targetEventId
  // (AD-2) and pinned to cell.sourceEventId (AD-9 staleness pin), then ping
  // the parent to revalidate useCells so the projection lands.
  const handleEditorCommit = useCallback(({ value, valueHtml }: { value: string; valueHtml: string }) => {
    if (!editable) return
    if (!project.id) return
    // F4 — Lock re-check at commit time. If another user now holds the lock
    // (lockHolderLabel is set at call time), the editor should already be
    // read-only, but the idle timer or an in-flight blur event may have
    // queued a commit just before or after the lock was taken. Abort and
    // trigger a soft revalidate so the user sees the latest projection.
    if (lockHolderLabel) {
      console.warn("[editor-commit] aborting: lock held by", lockHolderLabel)
      void onCellCommitted?.()
      return
    }
    // Optimistic local patch: applies BEFORE the outbox enqueue so this row's
    // signature (`status original translated`) shifts and `useHealth` re-runs
    // `checkRulesForCell` for this one cell on the next render — no other
    // cell's cached infractions are invalidated. The server projection
    // arrives via `onCellCommitted` -> revalidate and overwrites this.
    onOptimisticEdit?.(cell.id, { value, valueHtml })
    void emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
      sourceEventId: cell.sourceEventId ?? null,
      value,
      valueHtml,
      author: username,
    }).then((eventId) => {
      pendingTargetEventIdRef.current = eventId
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn("[editor-commit] enqueue failed:", err)
    })
  }, [editable, project.id, cell.fileId, cell.id, cell.targetEventId, cell.sourceEventId, username, onCellCommitted, onOptimisticEdit, lockHolderLabel])

  // Terminology apply: insert the chosen rendering into the target cell.
  // Appends to any existing target text so the translator can click multiple
  // terms in sequence. Uses the same commit path as keyboard edits.
  const handleTermApply = useCallback((rendering: string) => {
    const existing = cell.translated?.trim() ?? ""
    const next = existing ? `${existing} ${rendering}` : rendering
    handleEditorCommit({ value: next, valueHtml: next })
  }, [cell.translated, handleEditorCommit])

  // FRO-204: Chip click handler for terminology chips in the target (TranslatedEditor).
  // Records whether the target editor had a non-empty text selection at click time
  // so we can conditionally surface the Apply affordance in the popover.
  const handleTermChipClick = useCallback((term: string, anchor: HTMLElement) => {
    const sel = window.getSelection()
    targetHasSelectionRef.current = Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0)
    setTermChipState({ term, anchor })
  }, [])

  const emitValidationChange = useCallback((validated: boolean) => {
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
      void onCellCommitted?.()
    }).catch((err) => {
      console.warn(`[${validated ? "validate" : "unvalidate"}] emit failed:`, err)
    })
  }, [cell.fileId, cell.id, cell.targetEventId, project.id, username, onCellCommitted])

  const handleEditorFocus = useCallback(() => {
    onClaimCell?.(cell.id)
    onAckRemoteChange?.(cell.id)
  }, [cell.id, onClaimCell, onAckRemoteChange])

  const handleEditorBlurOuter = useCallback(() => {
    onReleaseCell?.(cell.id)
  }, [cell.id, onReleaseCell])

  const handleDiscardLocalAndReload = useCallback(() => {
    onAckRemoteChange?.(cell.id)
    onCellCommitted?.()
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

  // Minimal CodexCell shape for the audio hook — only the metadata fields it
  // actually reads (selectedAudioId, attachments). Avoids plumbing the entire
  // CodexCell through CellData.
  const cellForAudio = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: cell.selectedAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.id, cell.type, cell.translated, cell.attachments, cell.selectedAudioId,
  ])
  const audioController = useCellAudio(project, cellForAudio, cell.fileId)
  const cellForGeneratedVoice = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: cell.translated ?? "",
    metadata: {
      id: cell.id,
      type: (cell.type ?? "text") as "text",
      attachments: cell.attachments,
      selectedAudioId: cell.selectedGeneratedVoiceAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.id, cell.type, cell.translated, cell.attachments, cell.selectedGeneratedVoiceAudioId,
  ])
  const generatedVoiceController = useCellAudio(project, cellForGeneratedVoice, cell.fileId)

  // When this cell starts playing, gently bring it into view if it's
  // off-screen. Skips when the user is actively interacting with another cell
  // (focus inside an editable element).
  const rowRef = useRef<HTMLDivElement | null>(null)
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

  const handleTranscribe = useCallback(async () => {
    // Phase 2c-gamma: transcribeAndStoreTimings wrote per-word timings into
    // the per-file Y.Doc. The grammar that brings forced-alignment writebacks
    // to the event log lands in v1.x; this gesture is a no-op for now.
    const audioId = cell.selectedAudioId
    if (!audioId) return
    setTranscribeStatus(audioId, { kind: "idle" })
  }, [cell.selectedAudioId])

  // Build tooltip detail. Prefer the live examples surfaced in the popover
  // (cellExamples) over the history snapshot — history's `examples` only gets
  // populated on commit, so an in-progress / freshly generated cell would
  // otherwise read "no examples" while the popover clearly shows several.
  const lastEntry = cell.history[cell.history.length - 1]
  const exampleCount = cellExamples.length > 0
    ? cellExamples.length
    : (lastEntry?.examples?.length ?? 0)
  const healthTooltip = cell.status === "empty"
    ? undefined
    : cell.status === "validated"
      ? `Health: ${healthValue}% — validated`
      : exampleCount === 0
        ? `Health: ${healthValue}% — no examples`
        : `Health: ${healthValue}% — ${exampleCount} example${exampleCount !== 1 ? "s" : ""}`

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
    if (details.reason === "trigger-press") {
      if (editable && !isSelfValidated) {
        emitValidationChange(true)
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
  // full-others = fully validated but current user has NOT validated (double-check, teal/muted)
  const ValidationIcon =
    vs === "full-self" || vs === "full-others" ? CheckCheck :
    vs === "self" ? Check :
    Circle
  const validationColorClass =
    vs === "full-self" ? "text-emerald-500" :
    vs === "full-others" ? "text-teal-400" :
    vs === "self" ? "text-emerald-500" :
    vs === "others" ? "text-muted-foreground/60" :
    "text-muted-foreground/30"

  const hasContent = Boolean(cell.translated && cell.translated.trim())

  // AD-14: a translated cell shows an inline "needs attention" marker when its
  // decay is above the warn threshold (endorsement_count too low). Absence is
  // silence, not endorsement — there is no green "done" ring at cell scope. The
  // target defaults to the project's required-validations gate so a validated
  // cell clears the marker (resolveDecayConfig).
  const decayConfig = useMemo(
    () => resolveDecayConfig(project.decaySettings, readValidationCount(project)),
    [project.decaySettings, project.validationCount],
  )
  const cellNeedsAttention = hasContent && needsAttention(cell.endorsementCount ?? 0, decayConfig)

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

  // The cell number IS the issue surface: a single pill (top-left of the card)
  // that tints by worst severity and reveals the concrete issue list on hover.
  // Replaces the old severity stripe, gutter warning triangle, and dot — there
  // is now exactly one place that color-codes problems.
  const hasAnyIssue = infractionCount > 0 || cellNeedsAttention
  const numberLabel = showLineNumber ? String(rowIndex + 1) : null
  const numberPillInner = (
    <CellNumberPill
      number={numberLabel}
      label={showCellLabel ? labelText : null}
      tint={hasMajorInfraction ? "major" : hasAnyIssue ? "issue" : "none"}
    />
  )
  const numberPill = !(showLineNumber || showCellLabel) ? null : hasAnyIssue ? (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={<button type="button" className="cursor-help">{numberPillInner}</button>}
      />
      <PopoverContent side="right" align="start" className="w-64 rounded-xl p-2 shadow-neu-lg">
        <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {infractionCount > 0
            ? `${infractionCount} issue${infractionCount !== 1 ? "s" : ""}`
            : "Needs attention"}
        </p>
        <ul className="space-y-0.5">
          {cellInfractions.map((inf) => {
            const major = ruleMap.get(inf.ruleId)?.severity === "major"
            return (
              <li key={inf.ruleId} className="flex items-start gap-1.5 px-1 py-1 text-xs">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                    major ? "bg-red-500" : "bg-amber-500",
                  )}
                />
                <span className="flex-1">
                  <span className="font-medium text-foreground">
                    {ruleMap.get(inf.ruleId)?.name ?? inf.ruleId}
                  </span>
                  {inf.message && <span className="ml-1 text-muted-foreground">— {inf.message}</span>}
                </span>
              </li>
            )
          })}
          {cellNeedsAttention && (
            <li className="flex items-start gap-1.5 px-1 py-1 text-xs">
              <span aria-hidden className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <span className="flex-1 text-muted-foreground">
                Neighborhood not yet validated — needs attention.
              </span>
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  ) : (
    <span title={numberLabel ? `Line ${numberLabel}` : "Cell label"}>{numberPillInner}</span>
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

  return (
    // Each cell is a flat row in a continuous list — no dividers; rows separate
    // by spacing and hover/selection overlays alone (Linear's quietest list).
    // The expansion panel is indented + bordered so it still reads as the row's
    // child. No card, no shadow.
    <div>
      <div
        ref={rowRef}
        className={cn(
          // Flat row in a continuous list: tinted by hover/selection overlays,
          // not shadows. Depth is gone by design — the Linear model reserves
          // elevation for floating layers.
          "group relative grid gap-2 overflow-hidden px-4 py-2 transition-colors duration-150 ease-out",
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
      >
        {/* Left gutter — the number pill pins to the top-left and the
            validation circle to the bottom-left of the card. The number pill is
            the single issue surface (tint + hover list); no stripe/dot/warning.
            Selection lives on the source/target divider so range selection
            follows the text. */}
        <div className="flex h-full flex-col items-center gap-1 py-0.5">
          {numberPill}
          {(isSynthBusy || isSynthError) && (
            <SynthStatusBadge status={synthStatus} cellId={cell.id} projectId={project.id} onOpenAudioSetup={onOpenAudioSetup} />
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
            data-showcase="editor.source"
            className={cn(
              "flex flex-col transition-opacity",
              isSynthBusy && "opacity-70",
            )}
            dir={sourceTextDirection}
          >
            <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground" dir="ltr">
              <span>{cell.context}</span>
              {showFormattingLossWarning && (
                <span
                  title="Source has inline formatting (bold, italic, etc.) that the target doesn't preserve. Formatting will be lost on export."
                  className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  formatting
                </span>
              )}
            </div>
            {cell.originalHtml ? (
              <div
                className="text-sm"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(cell.originalHtml) }}
              />
            ) : (
              <SourceWithTermLookup
                text={cell.original}
                highlights={highlights}
                ranges={sourceRanges}
                showEvidence={examplesExpanded}
                onRangeClick={openInlineRule}
                concepts={project.terminology ?? []}
                onTermApply={handleTermApply}
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
          data-showcase="editor.target"
          className={cn(
            "relative flex flex-col pl-3 pr-9 transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          dir={targetTextDirection}
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
          <button
            type="button"
            role="checkbox"
            aria-checked={isMultiSelected}
            aria-label={isMultiSelected ? "Selected cell. Drag to extend selection." : "Select cell. Drag to select a range."}
            onPointerDown={onSelectionPointerDown}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute left-0 top-1/2 z-20 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border",
              "touch-none cursor-ns-resize transition-[opacity,transform,color,background-color] duration-150 ease-out",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2",
              isMultiSelected
                ? "border-transparent bg-primary text-primary-foreground opacity-100"
                : "border-border bg-card text-muted-foreground/70 opacity-60 hover:text-primary group-hover:opacity-100",
            )}
            title={isMultiSelected ? "Selected. Drag up or down to extend the range." : "Select cell. Drag up or down to select a range."}
          >
            {isMultiSelected ? (
              <Check className="h-3 w-3" strokeWidth={3} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
            )}
          </button>
          <div className="flex flex-1 flex-col">
            {/* Editable target is flat at rest (symmetric with the source) and
                only lifts into a muted well on hover/focus. Empty cells keep a
                faint resting fill as a "translate here" cue. Chrome only — no
                editor logic touched. */}
            <div
              className={cn(
                "relative flex min-h-[40px] flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors",
                "hover:bg-muted/60 focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
                !cell.translated?.trim() && "bg-muted/40",
              )}
              onKeyDown={(e) => {
                // FRO-174: Tab accepts the completion preview; Esc rejects it.
                // Only intercept when a "done" preview is waiting for the user.
                if (!completionDone || !completionPreview) return
                if (e.key === "Tab") {
                  e.preventDefault()
                  void onAcceptCompletion?.(cell)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  onRejectCompletion?.(cell.id)
                }
              }}
            >
              <TranslatedEditor
                cellId={cell.id}
                initialPlain={cell.translated}
                initialHtml={cell.translatedHtml}
                onCommit={handleEditorCommit}
                onFocus={handleEditorFocus}
                onBlur={handleEditorBlurOuter}
                className={cn("w-full", (isLoading || completionDone) && "opacity-30 transition-opacity")}
                editable={editable && !isLoading && !completionDone}
                heldByLabel={lockHolderLabel}
                infractions={[...cellInfractions, ...waivedInfractions]}
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
              />
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
                  running. We show the text as it streams in so the user
                  sees progress instead of waiting for the commit + outbox
                  flush to land. Pointer-events-none so it doesn't fight
                  the underlying TipTap editor (we just dim TipTap to
                  opacity-30 to keep it as the canonical layer). When
                  isLoading flips off post-commit, TipTap re-renders with
                  `cell.translated` and the overlay disappears — no
                  flicker because the text matches. */}
              {isLoading && (
                <div
                  aria-live="polite"
                  aria-busy="true"
                  className="pointer-events-none absolute inset-0 flex text-sm"
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
                    <div className="m-auto flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-muted-foreground shadow-neu-sm">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      <span>
                        {loadingPhase === "searching"
                          ? "Looking up similar examples…"
                          : "Generating translation…"}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {/* FRO-174: Completion-done overlay — shown when the LLM has
                  finished and the preview is waiting for user accept/reject.
                  Tab accepts (writes the cell); Esc rejects (discards).
                  The keydown is on the parent wrapper div below — this
                  overlay is pointer-events-none so focus stays on TipTap. */}
              {completionDone && completionPreview && (
                <div
                  aria-live="polite"
                  aria-label="AI suggestion ready — Tab to accept, Esc to dismiss"
                  className="pointer-events-none absolute inset-0 flex flex-col text-sm"
                >
                  <p className="whitespace-pre-wrap px-2 py-1 leading-relaxed text-foreground/90">
                    {completionPreview}
                  </p>
                  <div className="mt-auto flex items-center gap-1 px-2 pb-1 text-[10px] text-muted-foreground">
                    <kbd className="rounded border border-border bg-muted px-1 font-mono">Tab</kbd>
                    <span>accept</span>
                    <span className="mx-1 opacity-40">·</span>
                    <kbd className="rounded border border-border bg-muted px-1 font-mono">Esc</kbd>
                    <span>dismiss</span>
                  </div>
                </div>
              )}
            </div>
            {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
          </div>
        </div>

        {/* Floating action rail — anchored to the row's right edge. z-20 so
            it sits above the sticky column header (z-10). Without this, when
            a row is positioned at the very top of the scroll container, the
            sticky header's stacking context wins (rows are position:relative
            with auto z-index, so the row's local z-10 doesn't escape the
            sticky header's z-10 context). */}
        <div className="pointer-events-none absolute right-2 top-1.5 z-20 flex">
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
                            : "Generate translation"
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
                    onCompleteSingle(cell)
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

              {/* Always-visible #2: Validate (mirrors gutter button inline in the rail) */}
              {hasContent && (
                <Popover open={validationPopoverOpen} onOpenChange={handleOpenChange}>
                  <PopoverTrigger
                    openOnHover
                    delay={400}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        data-showcase="cell.health"
                        className={cn(
                          "relative flex h-6 w-6 items-center justify-center rounded-full transition-[transform,color,background-color] duration-150 ease-out",
                          "active:scale-[0.88] disabled:cursor-not-allowed disabled:opacity-30",
                          "hover:bg-muted/80",
                          validationColorClass,
                          vs === "none" && "hover:text-emerald-500",
                          vs === "others" && "hover:text-emerald-500",
                          vs === "full-others" && "hover:text-emerald-500",
                        )}
                        title={healthTooltip}
                        disabled={!editable}
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
                    }
                  />
                  {vs !== "empty" && (
                    <PopoverContent
                      side="right"
                      align="start"
                      className="w-72 rounded-xl p-2 shadow-neu-lg"
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
                              {v === username && editable && (
                                <button
                                  type="button"
                                  className="flex-shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                                  title="Remove your validation"
                                  onClick={() => {
                                    emitValidationChange(false)
                                    setValidationPopoverOpen(false)
                                  }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
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
              {/* Stale-source indicator alongside validate button */}
              {isStaleSource && hasContent && (
                <StaleSourceIndicator
                  cellId={cell.id}
                  staleCellIds={new Set([cell.id])}
                />
              )}

              {/* ⋯ overflow — play/record, TTS, comments, seek-to-cue */}
              {(hasAudio || onOpenRecording || (cell.translated.trim().length > 0) || onOpenComments || onSeekToCue) && (
                <Popover>
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        aria-label="More cell actions"
                        title="More actions"
                        className={cn(
                          "flex h-6 w-6 items-center justify-center rounded-full",
                          "transition-[transform,color,background-color] duration-150 ease-out",
                          "active:scale-[0.88] hover:bg-muted/80",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                          openCommentCount > 0
                            ? "text-primary"
                            : "text-muted-foreground/70 hover:text-foreground",
                        )}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                        {openCommentCount > 0 && (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
                          />
                        )}
                      </button>
                    }
                  />
                  <PopoverContent side="bottom" align="end" className="w-48 rounded-xl p-1.5">
                    <div className="flex flex-col gap-0.5">
                      {/* Play / Record */}
                      {hasAudio ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (audioController.state === "loading") return
                            if (audioController.isPlaying) audioController.pause()
                            else void audioController.play()
                          }}
                          disabled={audioController.state === "loading"}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
                            "hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40",
                            audioController.isPlaying ? "text-primary" : "text-foreground",
                          )}
                        >
                          {audioController.isPlaying ? (
                            <Pause className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <Play className="h-3.5 w-3.5 shrink-0" />
                          )}
                          {audioController.isPlaying ? "Pause" : "Play audio"}
                        </button>
                      ) : onOpenRecording ? (
                        <div className="flex items-center gap-2 rounded-lg px-2 py-0.5">
                          <CellAudioRecordButton
                            onOpenRecording={() => onOpenRecording(cell.id)}
                            disabled={!editable || !onOpenRecording}
                            micDenied={micDenied}
                          />
                          <span className="text-xs text-foreground">Record audio</span>
                        </div>
                      ) : null}

                      {/* TTS */}
                      {cell.translated.trim().length > 0 && (
                        <div className="flex items-center gap-2 rounded-lg px-2 py-0.5">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
                        </div>
                      )}

                      {/* Comments */}
                      {onOpenComments && (
                        <button
                          type="button"
                          onClick={() => onOpenComments(cell.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
                            "hover:bg-muted/60",
                            openCommentCount > 0 ? "text-primary" : "text-foreground",
                          )}
                        >
                          <MessageCircle className="h-3.5 w-3.5 shrink-0" />
                          {openCommentCount > 0
                            ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}`
                            : "Add comment"}
                        </button>
                      )}

                      {/* Seek to cue */}
                      {onSeekToCue && (
                        <button
                          type="button"
                          onClick={() => onSeekToCue(cell.id)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/60"
                        >
                          <Play className="h-3.5 w-3.5 shrink-0" />
                          Play from this cue
                        </button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
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
              label: "Decay",
              content: (
                <div className="space-y-1.5 py-3 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">{cell.endorsementCount ?? 0}</span>
                    {" "}endorsement{(cell.endorsementCount ?? 0) === 1 ? "" : "s"} · health{" "}
                    <span className="font-medium text-foreground">{healthValue}%</span>
                  </p>
                  <p>
                    {cellNeedsAttention
                      ? "Needs attention — this cell's retrieval neighborhood hasn't been validated yet (AD-14)."
                      : "No attention needed — enough of this cell's neighborhood is validated."}
                  </p>
                </div>
              ),
            },
            {
              value: "backtranslation",
              icon: <FileText className="h-3 w-3" />,
              label: "BT",
              attentionDot: isBtStale ? "amber" : undefined,
              content: (
                <div className="flex flex-col gap-2">
                  {/* ── Action row ─────────────────────────────────────────── */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">BT</span>
                      {cell.backtranslation && cell.backtranslationForText === cell.translated && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                            btPolishOn
                              ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
                              : "bg-muted text-muted-foreground",
                          )}
                          title={btPolishOn ? "LLM-polished back-translation" : "Deterministic statistical back-translation"}
                        >
                          {btPolishOn ? "polished" : "statistical"}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Polish toggle — only when BT is present and user can edit */}
                      {editable && cell.backtranslation && (
                        <button
                          type="button"
                          onClick={() => setBtPolishOn((v) => !v)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                            btPolishOn
                              ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 hover:bg-violet-500/25"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                          title={btPolishOn ? "Polish on: LLM step will run on next generate" : "Polish off: statistical-only BT"}
                        >
                          <Sparkles className="h-3 w-3" />
                          Polish
                        </button>
                      )}
                      {/* Stale: one-click regenerate — does NOT auto-trigger */}
                      {isBtStale && (
                        <button
                          type="button"
                          onClick={() => onBacktranslate?.(cell)}
                          disabled={isBacktranslating || cell.translated.trim().length === 0}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                          title="Translation changed — click to regenerate BT"
                        >
                          <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                          Regenerate
                        </button>
                      )}
                      {/* No BT yet: generate button */}
                      {!cell.backtranslation && !isBtStale && (
                        <button
                          type="button"
                          onClick={() => onBacktranslate?.(cell)}
                          disabled={isBacktranslating || cell.translated.trim().length === 0}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                          {isBacktranslating ? "Generating…" : "Generate"}
                        </button>
                      )}
                      {/* Edit button — contributor+ only */}
                      {!btEditing && cell.backtranslation && (
                        editable ? (
                          <button
                            type="button"
                            onClick={handleBtEditStart}
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            Edit
                          </button>
                        ) : (
                          <span
                            className="inline-flex cursor-not-allowed items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground opacity-50"
                            title="Contributor+ required to edit back-translations"
                          >
                            Edit
                          </span>
                        )
                      )}
                    </div>
                  </div>

                  {/* ── BT body ─────────────────────────────────────────────── */}
                  {cell.translated.trim().length === 0 ? (
                    <p className="neu-inset rounded-xl px-3 py-3 text-center text-xs text-muted-foreground">
                      Translate this cell to see a back-translation.
                    </p>
                  ) : cell.backtranslation ? (
                    <>
                      {/* Stale indicator pill — above the italic paragraph */}
                      {isBtStale && (
                        <div className="inline-flex items-center gap-1 self-start rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Stale — translation has changed
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
                            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm italic text-foreground outline-none focus:ring-1 focus:ring-ring"
                          />
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={handleBtCancel}
                              className="rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={handleBtSave}
                              disabled={btSaving || !btEditValue.trim()}
                              className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {btSaving ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Read-only display — ONE italic paragraph, BT label prefix */
                        <p className="neu-inset rounded-lg px-3 py-2 text-sm italic leading-relaxed text-muted-foreground">
                          {cell.backtranslation}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="neu-inset rounded-xl px-3 py-3 text-center text-xs text-muted-foreground">
                      {isBacktranslating
                        ? "Generating back-translation…"
                        : "No back-translation yet. Click Generate to create one."}
                    </p>
                  )}
                  {/* ── FRO-207: Interlinear alignment panel ──────────────── */}
                  {alignmentModel && cell.original.trim() && cell.translated.trim() && (
                    <InterlinearAlignmentPanel
                      sourceText={cell.original}
                      targetText={cell.translated}
                      alignmentModel={alignmentModel}
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
                        />
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-neu-sm transition-all hover:shadow-neu active:shadow-neu-pressed disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Mic className="h-3 w-3" />
                          Re-record
                        </button>
                        <button
                          type="button"
                          onClick={handleTranscribe}
                          disabled={!editable || isTranscribing}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-neu-sm transition-all hover:shadow-neu active:shadow-neu-pressed disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Sparkles
                            className={cn(
                              "h-3 w-3",
                              isTranscribing && "animate-pulse",
                            )}
                          />
                          {isTranscribing ? "Transcribing…" : "Transcribe"}
                        </button>
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
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">AI generated voice. Drag a voice from the toolbar to regenerate, or:</span>
                        <button
                          type="button"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                          className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-neu-sm transition-all hover:shadow-neu active:shadow-neu-pressed disabled:cursor-not-allowed disabled:opacity-40"
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
                          title="Record audio"
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
                            className="neu-flat flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-all hover:shadow-neu active:shadow-neu-pressed"
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
                                className="neu-inset flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground/70 transition-all hover:shadow-neu-sm"
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
                        className="self-start inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-neu-sm transition-all hover:shadow-neu active:shadow-neu-pressed disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <HistoryIcon className="h-3 w-3" />
                        Open full history
                      </button>
                      <ul className="neu-inset divide-y divide-border/40 rounded-lg">
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
                              <div className="mt-0.5 truncate italic text-muted-foreground">
                                "{entry.value}"
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
    </div>
  )
}
