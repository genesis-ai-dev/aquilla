import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
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
  ArrowRight, Activity, NotebookPen, Info, Pencil, ChevronRight, ChevronDown, Music, Braces,
  Languages,
  Archive,
  Lock,
  Pilcrow,
  PilcrowRight,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/page"
import type { CellData } from "@/hooks/useCells"
import {
  type CellFootnoteDetails,
  type CellStore,
  readAtVersion,
  useCellIds,
  useCellStoreVersion,
  useCellView,
} from "@/hooks/useActiveCellStore"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { getCellPref, setCellPref } from "@/lib/store/audio-cell-prefs"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { TranslationRule, RuleInfraction, ProjectRecord, Voice, ProjectTtsSettings, OrderedBy } from "@/lib/parsers/types"
import { deriveParagraphs } from "@/lib/parsers/paragraphs"
import { hasTiming } from "@/lib/timeline/derive"
import { useEditorCapabilities } from "@/hooks/useProjectPermissions"
import { canPerform, canSwitchLanes } from "@/lib/sync/role-policy"
import { shouldAutoValidateHumanEdit } from "@/lib/review/auto-validation"
import { useDcsUpstreamCursor } from "@/hooks/useDcsUpstreamCursor"
import { emitTargetCellCommit, emitSourceCellCommit, emitCellValidate, emitCellUnvalidate, emitCellWaive, emitCellUnwaive } from "@/lib/sync/events-emit"
import { resolveSourceCommitParent, reconcilePendingSourceCommit } from "@/lib/sync/source-commit-chain"
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
import { useRailIdleHide } from "@/hooks/useRailIdleHide"
import { computeRailPinned } from "@/lib/editor/cell-rail-pin"
import { CellExpansion } from "./CellExpansion"
import { CellMetadataTab, hasCellMetadata } from "./CellMetadataTab"
import { tokenizeWords, activeWordRange } from "@/lib/audio/timings"
import { KaraokeReadText } from "./KaraokeReadText"
import { resolveCurrentCellIndex } from "@/lib/editor/current-index"
import { useCellAudio } from "@/hooks/useCellAudio"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { isSourceSegmentSelected } from "@/lib/audio/batch-audio"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"
import { isLaneArchived } from "@/components/project-lane-archive"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { CellNumberPill } from "./cell/CellNumberPill"
import { ChapterNavigator, type ChapterNavigationItem } from "./ChapterNavigator"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import { CellVoicePanel } from "./cell/CellVoicePanel"
// CellAudioRecordButton: getUnsupportedReason used by the rail mic denied-help
// popover (FRO-237). The component itself is no longer in the overflow popover.
import { getUnsupportedReason } from "./CellAudioRecordButton"
// AQU-513: plain file-picker upload next to the mic — works on mobile too.
import { CellAudioUploadButton } from "./CellAudioUploadButton"
import { useMicPermission } from "@/hooks/useMicPermission"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import {
  cellNumberLabel,
  chapterLabelFromCanonical,
  importDisplayLabel,
  verseLabelFromCanonical,
} from "@/lib/scripture-reference"
import {
  firstActuallyVisibleIndex,
  resolveActiveChapterLabel,
  rowMatchesChapterHeading,
  sectionLabelAtViewportStart,
} from "@/lib/chapter-navigation"
import { isPerfLogEnabled } from "@/lib/perf-log"
import {
  type DirectionMode,
  type TextDirection,
  resolveTextDirection,
} from "@/lib/text-direction"
import { partitionInfractions } from "@/lib/rules/waivers"
import { ViolationPopover, type ViolationAnchor } from "./ViolationPopover"
import { VOICE_ASSIGN_MIME } from "./VoiceLibraryPanel"
import type { RangeHighlight } from "./HighlightedText"
import { TermLookupPopover } from "./TermLookupPopover"
import type { Concept } from "@/lib/terminology/types"
import { PreAcceptanceWarningBand } from "./PreAcceptanceWarningBand"
import { detectPreAcceptanceWarnings } from "@/lib/terminology/preacceptance"
import { useFileFontSizes } from "@/lib/store/file-view-prefs"
import { getSkipReplaceConfirm, setSkipReplaceConfirm } from "@/lib/store/replace-confirm-pref"
import { useEditorActions } from "@/context/EditorActionsContext"
import { isInMemberScope } from "@/lib/sync/member-scopes"
import { AddConceptDialog } from "./AddConceptDialog"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import { buildSourceChip, type ContextChip } from "@/lib/agent/context-chip"
import { FootnoteInline } from "./footnotes/FootnoteInline"
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
import { defaultFootnoteRef } from "@/lib/footnotes/refs"
import { effectiveSourceText } from "@/lib/cell-text"
import { deleteFootnote, spliceFootnoteText } from "@/lib/footnotes/splice"
import type { FootnoteViewMode, VisibleFootnoteEntry } from "@/lib/footnotes/types"
import { hasMeaningfulRichText, prepareReadOnlyRichTextHtml } from "@/lib/richtext/editor-content"
import { findTermMatches } from "@/lib/richtext/terminology-chip-plugin"
import {
  useCellPresence,
  type CellPresencePeer,
  type ProjectPresenceStore,
  type TargetPresenceSelection,
} from "@/lib/sync/presence-store"

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
const EMPTY_CONCEPTS: Concept[] = []

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

function applyRowOverlays(
  cell: CellData,
  options: {
    audioEntry?: CellAudioEntry
    backtranslationText?: string
    projectId?: string | null
  },
): CellData {
  let next = cell

  if (options.audioEntry) {
    const attachments: NonNullable<CellData["attachments"]> = {}
    for (const [audioId, attachment] of Object.entries(options.audioEntry.attachments)) {
      attachments[audioId] = {
        url: attachment.url,
        type: "audio",
        ...(attachment.voiceId ? { voiceId: attachment.voiceId } : {}),
        ...(attachment.referenceAudioId ? { referenceAudioId: attachment.referenceAudioId } : {}),
        ...(attachment.durationMs != null ? { durationMs: attachment.durationMs } : {}),
      }
    }
    next = {
      ...next,
      attachments,
      selectedAudioId: options.audioEntry.selectedAudioId ?? undefined,
      selectedGeneratedVoiceAudioId: options.audioEntry.selectedGeneratedVoiceAudioId ?? undefined,
      audioTimings: options.audioEntry.audioTimings as NonNullable<CellData["audioTimings"]>,
    }
  }

  if (typeof options.backtranslationText === "string") {
    next = {
      ...next,
      backtranslation: options.backtranslationText,
      backtranslationForText: next.translated,
    }
  } else if (!next.backtranslation && options.projectId) {
    try {
      const raw = localStorage.getItem(`bt:${options.projectId}:${next.id}`)
      if (raw) {
        const { btText, targetEventId } = JSON.parse(raw) as {
          btText: string
          targetEventId: string
        }
        next = {
          ...next,
          backtranslation: btText,
          backtranslationForText: targetEventId === next.targetEventId ? next.translated : "",
        }
      }
    } catch {
      // Ignore private-browsing/quota/parse failures. Server hydration can retry.
    }
  }

  return next
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
  // AQU-522: deep-link with `?q=gemini` so the settings search filters to the
  // Voice card and the key entry is visible immediately (no scrolling/hunting).
  const openVoiceSetup = () =>
    onOpenAudioSetup ? onOpenAudioSetup() : navigate(`/project/${projectId}/settings?q=gemini`)
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
const EMPTY_EXTRACTED_FOOTNOTES: ExtractedFootnote[] = []
const EMPTY_CELL_FOOTNOTE_DETAILS: CellFootnoteDetails = {
  sourceFootnotes: EMPTY_EXTRACTED_FOOTNOTES,
  targetFootnotes: EMPTY_EXTRACTED_FOOTNOTES,
  sourceCount: 0,
  targetCount: 0,
  hasFootnotes: false,
}
const SELECTION_DRAG_THRESHOLD_PX = 3
const SELECTION_EDGE_SCROLL_ZONE_PX = 56
const SELECTION_EDGE_SCROLL_STEP_PX = 22

export type BacktranslationActionSource = "read-back" | "refresh" | "regenerate"

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  /** AQU-646: scroll to a cell by id in DISPLAY space (lens-sorted — correct
   *  for time-ordered files, where store order ≠ display order), optionally
   *  flashing it. Returns false when the id is not currently displayable. */
  scrollToCellId: (cellId: string, opts?: { flash?: boolean }) => boolean
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
  cellStore: CellStore
  username: string
  /**
   * AQU-538: the active target LANE. Threaded down to each row so target-side
   * emits (`target.cell.commit`, `cell.validate`/`cell.unvalidate`) carry
   * `targetLang`. `''`/undefined = the default lane, OMITTED from the wire by
   * the emit helpers, so N=1 is byte-identical.
   */
  activeLane?: string
  /**
   * AQU-602: all selectable target lanes, default lane FIRST as `''` (callers
   * build `['', ...targetLanes]`). When more than one is offered AND
   * `onLaneChange` is provided, the TARGET language tag in the column header
   * becomes a dropdown that switches the active lane. With one lane (or no
   * handler) the tag stays a static pill — byte-identical to the N=1 header.
   */
  lanes?: string[]
  /** AQU-601: archived lane tags (a subset of `lanes`). Archived lanes are
   *  hidden from the switcher by default and revealed behind a "show archived"
   *  toggle, so a mistaken/retired lane stops cluttering the picker while
   *  staying reachable. Absent/empty ⇒ every lane shows (pre-archive behavior). */
  archivedLanes?: string[]
  /** Called with the chosen lane (`''` = default) when the TARGET tag dropdown
   *  is used. Omit to keep the tag non-interactive. */
  onLaneChange?: (lane: string) => void
  /** Human label for the default (`''`) lane in the TARGET tag dropdown — the
   *  project/file's default target-language name. Non-default lanes label
   *  themselves with their own tag string. */
  defaultLaneLabel?: string
  /** AQU-583: opens the project's language settings so the target language is
   *  changeable from the TARGET column header. When provided, the target-language
   *  tag is always actionable — a single-lane project shows a clickable pill, a
   *  multi-lane project appends a "Change target language…" item under the lane
   *  switcher, and a project with no target language yet shows a "Set target
   *  language" affordance. Omit to keep the tag a static pill (the pre-AQU-583
   *  behaviour). */
  onEditTargetLanguage?: () => void
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
  onCellCommitted?: (cellId: string, committedEventId?: string, parentId?: string | null) => void | Promise<void>
  getPendingTargetEventId?: (cellId: string) => string | null
  /** Optimistic local patch fired BEFORE the outbox enqueue so the editor's
   *  rule infractions + per-cell UI re-derive instantly without waiting for
   *  the projection round-trip. The follow-up `onCellCommitted` -> revalidate
   *  overwrites this with the authoritative server projection. */
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  /** Map of cellId → presence holder label. When present, the cell editor
   *  goes read-only with an "Alice is editing" banner. */
  cellLockHolders?: ReadonlyMap<string, string>
  /** Project-wide presence store fed by the existing ProjectSync DO. Rows
   *  subscribe per-cell so target cursor motion does not rerender the table. */
  presenceStore?: ProjectPresenceStore | null
  /** Cell ids whose remote value changed while this client held the focus
   *  lock — surfaces the discard-and-reload banner. */
  cellsWithRemoteChange?: ReadonlySet<string>
  /** Parent-managed focus claim/release (per-cell). */
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
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
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<void>
  onCompleteBatch: (cells: CellData[]) => void
  /** p1-paragraph-ui-wiring: draft the whole paragraph group containing
   *  `cellId` as one model call. Omit to keep the rail button hidden
   *  (legacy/prop-less callers render unchanged). */
  onCompleteParagraph?: (cellId: string) => void
  healthMap: Map<string, number>
  infractions?: Map<string, RuleInfraction[]>
  rules?: TranslationRule[]
  // onInfractionClick moved to EditorActionsContext (FRO perf cleanup) — pure
  // pass-through, never consumed above the row.
  isBacktranslationConfigured?: boolean
  /** Generate the cell's back-translation with the configured LLM. */
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  backtranslationByCellId?: ReadonlyMap<string, string>
  /** Called when user saves a BT edit. Parent emits `cell.backtranslation.set`. */
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  /** On-demand statistical gloss (corpus-derived, never persisted) for the BT
   *  tab's collapsed reference section. */
  getStatisticalBt?: (translatedText: string) => string
  cellOpenCommentCount?: Map<string, number>
  // onOpenComments/onOpenHistory moved to EditorActionsContext (FRO perf
  // cleanup) — pure pass-through, never consumed above the row.
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceDirectionMode?: DirectionMode
  targetDirectionMode?: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
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
  /** FRO-477 (§6) — set of cell ids whose ANCESTRY is stale (inherited, a
   *  further-upstream chain hop changed). Renders the violet/dotted second
   *  tone on `StaleSourceIndicator`, layered onto the same prop path as
   *  `staleCellIds` above. */
  upstreamStaleCellIds?: ReadonlySet<string>
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
  project, cellStore, username, activeLane = "", lanes, archivedLanes, onLaneChange, defaultLaneLabel,
  onEditTargetLanguage,
  isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors, previews,
  onCompleteSingle, onCompleteBatch, onCompleteParagraph, healthMap,
  infractions = new Map(), rules = [],
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  backtranslationByCellId,
  onSaveBacktranslation, getStatisticalBt,
  cellOpenCommentCount,
  activeCueIndex, onSeekToCue,
  lineNumbersEnabled, cellLabelsEnabled, sourceDirectionMode = "auto", targetDirectionMode = "auto", sourceTextDirection, targetTextDirection,
  isAnonymous, onJumpToCell,
  audioLens, onOpenAudioSetup,
  onAttachMediaFile, onAttachMediaUrl,
  orderedBy,
  onProjectChanged, onAddConceptFromSelection, onAskAiFromSelection, onAssignVoice,
  onCellCommitted,
  getPendingTargetEventId,
  onOptimisticEdit,
  cellLockHolders,
  presenceStore,
  cellsWithRemoteChange,
  onClaimCell, onReleaseCell, onTargetPresenceSelection, onAckRemoteChange,
  staleCellIds,
  upstreamStaleCellIds,
  getTokenForFile,
  getAlignmentModel,
  onAlignmentSeedChange,
  checkLockHolder,
  showFootnotesInline,
  footnotePanelActive,
  footnoteViewMode = "off",
  onVisibleRefChange,
  onVisibleFootnotesChange,
  onFootnoteCreated,
}, ref) {
  // DCS lockdown: while this project is pinned to a Door43 upstream, the
  // repair path treats any hand-edited source cell as damage and overwrites
  // it, so the "Edit source" affordance must stay off. Loading counts as
  // linked (default-locked) — see useDcsUpstreamCursor.
  const { cursor: dcsCursor, loading: dcsCursorLoading } = useDcsUpstreamCursor(
    project.id,
    project.syncRole?.level ?? null,
  )
  const { canEdit, canValidate, canEditSource, sourceReadOnlyReason, readOnlyLabel } = useEditorCapabilities(project, {
    hasDcsUpstream: dcsCursorLoading || dcsCursor !== null,
  })
  // Probe mic permission once (shared across all rows) so the help affordance
  // on CellAudioRecordButton activates when the user has blocked the mic.
  const { micDenied } = useMicPermission(audioLens !== null)
  const parentRef = useRef<HTMLElement | null>(null)
  const listRootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<LegendListRef | null>(null)
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0)
  const [viewableIndexes, setViewableIndexes] = useState<number[]>([])
  const [chapterVisibleIndex, setChapterVisibleIndex] = useState<number | null>(null)
  const [chapterNavigationSelection, setChapterNavigationSelection] = useState<{
    fileId: string | null
    label: string
  } | null>(null)
  const clearChapterNavigationSelection = useCallback(() => {
    setChapterNavigationSelection(null)
  }, [])
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
  // AQU-601: the lane switcher hides archived lanes by default; this reveals
  // them within the open dropdown so a retired lane stays reachable.
  const [showArchivedLanes, setShowArchivedLanes] = useState(false)
  const laneSwitcher = useMemo(() => {
    const all = lanes ?? []
    return {
      visible: all.filter((l) => !isLaneArchived(l, archivedLanes)),
      archived: all.filter((l) => isLaneArchived(l, archivedLanes)),
    }
  }, [lanes, archivedLanes])
  const isDragging = useRef(false)
  const dragCells = useRef<Set<string>>(new Set())
  const displayCellIds = useCellIds(cellStore, orderedBy, !!audioLens)
  const displayCellIdsRef = useRef<readonly string[]>(displayCellIds)
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
  const chapterScrollFrameRef = useRef<number | null>(null)
  const selectionPointerYRef = useRef<number | null>(null)
  const previousBodyUserSelectRef = useRef<string | null>(null)

  displayCellIdsRef.current = displayCellIds

  // Durable cell audio (AD-2 cell.audio.* grammar). Per-file read; overlay each
  // visible row's attachments + selected clips at render time, rather than
  // cloning the entire active file into audio-enriched CellData objects.
  const audioFileId = cellStore.getFileId()
  const { byCellId: audioByCellId } = useFileAudioAttachments(project.id, audioFileId)

  // Timeline-segment-model (Scope A): the rendered row list. For a `'time'`-
  // ordered file the Text/Audio toggle is a medium-LAYER switch — Text layer
  // shows text segments, Audio (Media) layer shows media segments — and rows
  // sort by timing. For every other file this is byte-identical to today
  // (no filter, no reorder), so existing projects are untouched.
  //
  // NOTE: only the virtual row list is filtered here. Index-based voice paths
  // Combined-voice range lookup resolves through the active store at call time
  // so the editor does not keep a second full CellData[] just for audio.
  const isTimeOrdered = orderedBy === "time"
  const cellStoreVersion = useCellStoreVersion(cellStore)

  useEffect(() => {
    if (!activeEditorCellId) return
    if (displayCellIds.includes(activeEditorCellId)) return
    setActiveEditorCellId(null)
  }, [activeEditorCellId, displayCellIds])

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
  const editorFileId = audioFileId
  const { source: sourceFontSize, target: targetFontSize } = useFileFontSizes(editorFileId)

  const setListScrollElement = useCallback((node: unknown) => {
    parentRef.current = node instanceof HTMLElement ? node : null
  }, [])
  const getListQueryRoot = useCallback(() => parentRef.current ?? listRootRef.current, [])

  const updateChapterVisibleIndex = useCallback(() => {
    const viewport = listRootRef.current
    const root = getListQueryRoot()
    if (!viewport || !root) return

    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-cell-id][data-index]"))
      .map((row) => {
        const index = Number(row.dataset.index)
        if (!Number.isInteger(index)) return null
        const rect = row.getBoundingClientRect()
        return { index, top: rect.top, bottom: rect.bottom }
      })
      .filter((row): row is { index: number; top: number; bottom: number } => row !== null)
    const nextIndex = firstActuallyVisibleIndex(
      rows,
      viewport.getBoundingClientRect().top,
      firstVisibleIndex,
    )
    setChapterVisibleIndex((current) => current === nextIndex ? current : nextIndex)
  }, [firstVisibleIndex, getListQueryRoot])

  const handleListScroll = useCallback(() => {
    if (chapterScrollFrameRef.current !== null) return
    chapterScrollFrameRef.current = requestAnimationFrame(() => {
      // Legend List applies its row transforms after the scroll callback.
      // Read geometry on the following frame so positions are settled.
      chapterScrollFrameRef.current = requestAnimationFrame(() => {
        chapterScrollFrameRef.current = null
        updateChapterVisibleIndex()
      })
    })
  }, [updateChapterVisibleIndex])

  useEffect(() => () => {
    if (chapterScrollFrameRef.current !== null) {
      cancelAnimationFrame(chapterScrollFrameRef.current)
    }
  }, [])

  useEffect(() => {
    setFirstVisibleIndex((current) => clampIndex(current, displayCellIds.length))
    setChapterVisibleIndex((current) => current === null
      ? null
      : clampIndex(current, displayCellIds.length))
    setViewableIndexes((current) => {
      const next = current.filter((index) => index >= 0 && index < displayCellIds.length)
      return next.length === current.length ? current : next
    })
  }, [displayCellIds.length])

  const clampCellIndex = useCallback((index: number) => {
    const last = displayCellIdsRef.current.length - 1
    if (last < 0) return -1
    return Math.max(0, Math.min(last, index))
  }, [])

  // Move keyboard focus into the target editor at `index`, placing the caret
  // at the end. Legend List may recycle/mount the destination row a frame or
  // two after scrollToIndex, so retry briefly until the DOM node exists.
  const focusCellEditorByIndex = useCallback((index: number) => {
    const list = displayCellIdsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index]
    clearChapterNavigationSelection()
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
  }, [clearChapterNavigationSelection, getListQueryRoot])

  // AQU-646 round 3: shared flash body — scroll-by-id and the legacy flashCell
  // both defer to the next frame (the list may still be scrolling, so the DOM
  // node may not exist yet).
  const flashCellDom = useCallback((cellId: string) => {
    requestAnimationFrame(() => {
      const root = getListQueryRoot()
      if (!root) return
      const el = root.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`)
      if (!el) return
      el.classList.add("codex-search-flash")
      window.setTimeout(() => el.classList.remove("codex-search-flash"), 1800)
    })
  }, [getListQueryRoot])

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < displayCellIds.length) {
        clearChapterNavigationSelection()
        void listRef.current?.scrollToIndex({
          index,
          viewPosition: 0.5,
          animated: false,
        })
      }
    },
    scrollToCellId(cellId, opts) {
      // AQU-646 round 3: id-based scroll in DISPLAY space. The older
      // index-based path resolved indexes via cellStore.findIndexByCellId —
      // STORE order — but the list renders displayCellIds, which time-ordered
      // files re-sort by timing, so those jumps could land on the wrong row.
      const index = displayCellIdsRef.current.indexOf(cellId)
      if (index < 0) return false
      clearChapterNavigationSelection()
      void listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false })
      if (opts?.flash) flashCellDom(cellId)
      return true
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
        displayCells: displayCellIdsRef.current.map((id) => ({ id })),
        cells: cellStore.getAllSummaries(),
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
      flashCellDom(cellId)
    },
  }), [clearChapterNavigationSelection, displayCellIds.length, cellStore, focusCellEditorByIndex, getListQueryRoot, flashCellDom])

  // FRO-297: Focus the grid-row wrapper div (not TipTap) at `index`.
  // Used for Esc-to-grid and arrow-key navigation while NOT in edit mode.
  // The wrapper div has tabIndex={0} so it can receive programmatic focus.
  const focusGridRowByIndex = useCallback((index: number) => {
    const list = displayCellIdsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index]
    clearChapterNavigationSelection()
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
  }, [clearChapterNavigationSelection, getListQueryRoot])

  // Resolve a navigation request from a cell editor (Up/Down/Tab) to the
  // adjacent cell and focus it. Out-of-range steps (top/bottom edge) no-op.
  const handleNavigateCell = useCallback((cellId: string, direction: "prev" | "next") => {
    const idx = displayCellIdsRef.current.indexOf(cellId)
    if (idx < 0) return
    focusCellEditorByIndex(direction === "next" ? idx + 1 : idx - 1)
  }, [focusCellEditorByIndex])

  // FRO-297: Esc from a cell editor — commit-and-return to grid row focus.
  const handleEscapeToGrid = useCallback((cellId: string) => {
    const idx = displayCellIdsRef.current.indexOf(cellId)
    if (idx < 0) return
    focusGridRowByIndex(idx)
  }, [focusGridRowByIndex])

  // FRO-297: Arrow-key (or j/k) navigation within the grid (row focused, not TipTap).
  // This is called from the row's own keydown when focus is on the grid row wrapper.
  const handleGridRowKeyNav = useCallback((cellId: string, direction: "prev" | "next") => {
    const idx = displayCellIdsRef.current.indexOf(cellId)
    if (idx < 0) return
    focusGridRowByIndex(direction === "next" ? idx + 1 : idx - 1)
  }, [focusGridRowByIndex])

  const selectRangeByIndexes = useCallback((anchorIndex: number, focusIndex: number) => {
    const list = displayCellIdsRef.current
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
    const ids = list.slice(start, end + 1)
    setSelection(ids, list[anchor] ?? ids[0] ?? null)
  }, [])

  const getIndexAtClientY = useCallback((clientY: number) => {
    const scrollEl = parentRef.current ?? listRootRef.current
    const list = displayCellIdsRef.current
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
    const ids = displayCellIdsRef.current
    const anchorId = getSelectionAnchorId()
    const anchorIndex = anchorId ? ids.indexOf(anchorId) : -1
    // FRO-348: range-select must be an explicit Shift-click. Previously a
    // plain click on any unselected cell silently extended the range from
    // the old anchor whenever *something* was already selected — no
    // modifier, no visual preview. Under concurrent editing the anchor's
    // row could have shifted since it was set, so the silently-computed
    // range would land 1-2 rows off, or not start on the clicked cell at
    // all. A plain click must always mean "select exactly this cell."
    const shouldRange = !isAdditive && anchorIndex >= 0 && e.shiftKey
    const startIndex = shouldRange ? anchorIndex : rowIndex

    selectionDragRef.current = {
      pointerId: e.pointerId,
      anchorIndex: clampIndex(startIndex, ids.length),
      lastIndex: clampIndex(rowIndex, ids.length),
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
      const selectedIds = displayCellIdsRef.current.filter((id) => dragCells.current.has(id))
      const selected = cellStore.getCellsByIds(selectedIds)
      onCompleteBatch(selected)
    }
    isDragging.current = false
    dragCells.current = new Set()
  }, [cellStore, onCompleteBatch])

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
    return cellStore.getCellsByIds(displayCellIdsRef.current.slice(startIndex, startIndex + count))
  }, [cellStore])

  const firstVisibleCellId = displayCellIds[firstVisibleIndex] ?? null
  const currentSectionLabel = useMemo(() => {
    const visibleIndex = chapterVisibleIndex ?? firstVisibleIndex
    const baseLabel = sectionLabelAtViewportStart(
      displayCellIds,
      visibleIndex,
      (cellId) => cellStore.getSectionLabelForCellId(cellId),
    )
    const nextSection = cellStore.getNavigationIndex().find(
      (entry) => entry.firstIndex > visibleIndex,
    )
    const cellId = displayCellIds[visibleIndex]
    const cell = cellId ? cellStore.getCellView(cellId) : null
    const nextDisplayLabel = chapterLabelFromCanonical(nextSection?.label)
    if (
      nextSection
      && nextDisplayLabel
      && cell
      && rowMatchesChapterHeading([cell.original, cell.translated], nextDisplayLabel)
    ) {
      return nextSection.label
    }
    return baseLabel
  }, [cellStore, cellStoreVersion, chapterVisibleIndex, displayCellIds, firstVisibleIndex])

  const chapterNavigationItems = useMemo<ChapterNavigationItem[]>(() =>
    readAtVersion(cellStoreVersion, () => {
      const navigation = cellStore.getNavigationIndex()
      const summaries = cellStore.getAllSummaries()
      return navigation
        .map((entry, index) => {
          const displayLabel = chapterLabelFromCanonical(entry.label)
          if (looksLikeUuid(entry.label) || !displayLabel) return null
          const endIndex = navigation[index + 1]?.firstIndex ?? summaries.length
          const verseLabels = summaries
            .slice(entry.firstIndex, endIndex)
            .map((cell) => verseLabelFromCanonical(cell.group))
            .filter((label): label is string => Boolean(label))
          const firstVerse = verseLabels[0] ?? null
          const lastVerse = verseLabels[verseLabels.length - 1] ?? null
          return {
            label: entry.label,
            displayLabel,
            verseRange: firstVerse && lastVerse
              ? firstVerse === lastVerse ? firstVerse : `${firstVerse}–${lastVerse}`
              : null,
            translated: entry.translated,
            validated: entry.validated,
            total: entry.total,
          }
        })
        .filter((entry): entry is ChapterNavigationItem => entry !== null)
    }),
  [cellStore, cellStoreVersion])

  // AQU-610: sequential (non-scripture) numbering counts only *numbered*
  // (non-paratext) cells, so the count starts at 1 at the first real content
  // cell and stays gap-free even when front matter, introductions, or other
  // paratextual cells sit before/among the content. Scripture files number by
  // canonical verse ref and don't consult this map.
  const sequentialNumberByCellId = useMemo(() =>
    readAtVersion(cellStoreVersion, () => {
      const map = new Map<string, number>()
      let ordinal = 0
      for (const id of displayCellIds) {
        const view = cellStore.getCellView(id)
        if (!view) continue
        if (
          view.type === "paratext"
          || view.type === "heading"
          || importDisplayLabel(view.metadata) === null
        ) continue
        map.set(id, ++ordinal)
      }
      return map
    }),
  [cellStore, cellStoreVersion, displayCellIds])

  // p1-paragraph-ui-wiring (Task 3 + coordinator follow-up): paragraph group
  // info, keyed by the group's start cell id — drives the "Draft paragraph"
  // rail button's visibility/label/dialog copy and its in-flight guard. Only
  // start cells (the only ones the button can render on) need an entry, but
  // deriveParagraphs needs the full ordered per-file cell list to find file/
  // paragraph boundaries, so this walks displayCellIds once, same idiom as
  // sequentialNumberByCellId above. Legacy imports (no paragraphStart flags
  // anywhere) still produce one group per file — harmless, since the rail
  // button is separately gated on `cell.paragraphStart === true`, which never
  // holds for those cells.
  //
  // `draftableCount` excludes already-validated cells (the same `status ===
  // "validated"` signal completeParagraph's skip logic uses — kept
  // consistent so the dialog's "N of M" copy never lies) — see AQU
  // (coordinator adjudication) review of the original "Draft this paragraph?
  // N cells…" copy, which used the full group size even when some cells
  // were validated and would be skipped.
  //
  // `memberIds` is every cell id in the group (including the start cell
  // itself) — used ONLY by MemoizedRow to derive a per-row `groupInFlight`
  // boolean from the `completing` map (any member cell mid-draft ⇒ the
  // button disables/pulses, and a click can't re-fire while a previous
  // click's fan-out is still running).
  const paragraphGroupInfoByCellId = useMemo(() =>
    readAtVersion(cellStoreVersion, () => {
      const map = new Map<string, { size: number; draftableCount: number; memberIds: string[] }>()
      const orderedCells: { id: string; fileId: string; paragraphStart?: boolean }[] = []
      for (const id of displayCellIds) {
        const view = cellStore.getCellView(id)
        if (!view) continue
        orderedCells.push({ id: view.id, fileId: view.fileId, paragraphStart: view.paragraphStart })
      }
      for (const group of deriveParagraphs(orderedCells)) {
        if (group.length <= 1) continue
        let draftableCount = 0
        for (const id of group) {
          if (cellStore.getCellView(id)?.status !== "validated") draftableCount++
        }
        map.set(group[0], { size: group.length, draftableCount, memberIds: group })
      }
      return map
    }),
  [cellStore, cellStoreVersion, displayCellIds])

  const selectedChapterLabel = chapterNavigationSelection?.fileId === audioFileId
    ? chapterNavigationSelection.label
    : null
  const activeChapterLabel = resolveActiveChapterLabel(
    chapterNavigationItems.map((chapter) => chapter.label),
    currentSectionLabel,
    selectedChapterLabel,
  )

  const handleChapterListPointerDownCapture = useCallback((event: React.PointerEvent) => {
    // Touch/pen gestures and a mouse press on the scroll container indicate
    // manual scrolling. A normal click inside a row should not discard the
    // chapter the user just chose.
    if (event.pointerType !== "mouse" || event.target === parentRef.current) {
      clearChapterNavigationSelection()
    }
  }, [clearChapterNavigationSelection])

  const handleChapterListKeyDownCapture = useCallback((event: React.KeyboardEvent) => {
    const target = event.target
    if (
      target instanceof HTMLElement
      && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))
    ) return
    if (
      event.key === "ArrowUp"
      || event.key === "ArrowDown"
      || event.key === "PageUp"
      || event.key === "PageDown"
      || event.key === "Home"
      || event.key === "End"
      || event.key === " "
    ) {
      clearChapterNavigationSelection()
    }
  }, [clearChapterNavigationSelection])

  const handleChapterSelect = useCallback((label: string) => {
    const index = cellStore.findIndexBySection(label)
    if (index < 0) return
    setChapterNavigationSelection({ fileId: audioFileId, label })
    setFirstVisibleIndex(index)
    setChapterVisibleIndex(index)
    void listRef.current?.scrollToIndex({
      index,
      viewPosition: 0,
      animated: true,
    })
  }, [audioFileId, cellStore])

  // Parallel-bibles sidebar tracking: report the first visible row's canonical
  // ref as the user scrolls. Keyed on the derived ref string
  // so the effect only fires on actual row changes, not every scrolled pixel.
  const firstVisibleRef = useMemo(() => {
    if (!firstVisibleCellId) return null
    return readAtVersion(cellStoreVersion, () => cellStore.getCellView(firstVisibleCellId)?.group || null)
  }, [cellStore, cellStoreVersion, firstVisibleCellId])
  useEffect(() => {
    onVisibleRefChange?.(firstVisibleRef)
  }, [firstVisibleRef, onVisibleRefChange])

  const visibleFootnoteEntries = useMemo<VisibleFootnoteEntry[]>(() => {
    if (!onVisibleFootnotesChange || displayCellIds.length === 0) return []

    const indexes = viewableIndexes.length > 0 ? viewableIndexes : [firstVisibleIndex]
    return readAtVersion(cellStoreVersion, () => indexes
      .map((index) => {
        const cellId = displayCellIds[index]
        const cell = cellId ? cellStore.getCellView(cellId) : null
        if (!cell) return null
        const offsets = cellStore.getFootnoteOffsets(cell.id)
        const footnotes = cellStore.getCellFootnotes(cell.id)
        if (!footnotes.hasFootnotes) return null
        return {
          cellId: cell.id,
          cellLabel: cell.cellLabel || String(index + 1),
          cellRef: humanFootnoteCellRef(cell),
          rowIndex: index,
          sourceFootnotes: footnotes.sourceFootnotes,
          targetFootnotes: footnotes.targetFootnotes,
          activeFootnoteIndex: hoveredFootnote?.cellId === cell.id ? hoveredFootnote.index : null,
          isDocx: (cell.fileId ?? "").endsWith(".docx"),
          numberOffset: offsets.target,
        }
      })
      .filter((entry): entry is VisibleFootnoteEntry => entry !== null))
  }, [cellStore, cellStoreVersion, displayCellIds, firstVisibleIndex, hoveredFootnote, onVisibleFootnotesChange, viewableIndexes])

  useEffect(() => {
    onVisibleFootnotesChange?.(visibleFootnoteEntries)
  }, [onVisibleFootnotesChange, visibleFootnoteEntries])

  useEffect(() => () => {
    onVisibleFootnotesChange?.([])
  }, [onVisibleFootnotesChange])

  const handleFirstVisibleItemChanged = useCallback((info: {
    index: number
    item: string
    key: string
  }) => {
    setFirstVisibleIndex(clampIndex(info.index, displayCellIds.length))
  }, [displayCellIds.length])

  const handleViewableItemsChanged = useCallback((info: OnViewableItemsChangedInfo<string>) => {
    const next = info.viewableItems
      .map((item) => item.index)
      .filter((index) => index >= 0 && index < displayCellIds.length)
      .sort((a, b) => a - b)
    setViewableIndexes((current) => areNumberArraysEqual(current, next) ? current : next)
  }, [displayCellIds.length])

  const getFootnoteDetails = useCallback(
    (cellId: string) => cellStore.getCellFootnotes(cellId),
    [cellStore],
  )

  const renderListItem = useCallback(({ item: cellId, index }: LegendListRenderItemProps<string>) => {
    const audioEntry = audioByCellId.get(cellId)
    const backtranslationText = backtranslationByCellId?.get(cellId)
    return (
      <CellStoreRow
        cellId={cellId}
        cellStore={cellStore}
        audioEntry={audioEntry}
        backtranslationText={backtranslationText}
        projectId={project.id}
      >
        {(cell) => {
          const untimedInTimeLens = isTimeOrdered && !hasTiming(cell)
          const footnoteOffsets = cellStore.getFootnoteOffsets(cell.id)
          // AQU: paragraph-boundary visuals (p1-paragraph-ui-wiring). Only the
          // FIRST cell of a paragraph carries paragraphStart; the file header
          // already delimits the first paragraph of a file, so suppress the
          // extra rule/pilcrow there to avoid a stray line at the top of every
          // file. "First of file" is derived from the previous row's cached
          // fileId (no new subscription — a synchronous cellStore getter,
          // same idiom as footnoteOffsets above).
          const isFirstOfFile = index === 0
            || cellStore.getCellView(displayCellIds[index - 1])?.fileId !== cell.fileId
          const showParagraphBoundary = cell.paragraphStart === true && !isFirstOfFile
          // p1-paragraph-ui-wiring (Task 3): only paragraph-start cells carry
          // group info; every other row gets undefined so its rail button
          // gate (paragraphGroupSize !== undefined) resolves false.
          const paragraphGroupInfo = cell.paragraphStart === true
            ? paragraphGroupInfoByCellId.get(cell.id)
            : undefined
          return (
      <div
        data-cell-id={cell.id}
        data-index={index}
        data-untimed={untimedInTimeLens ? "true" : undefined}
        data-paragraph-start={showParagraphBoundary ? "true" : undefined}
        aria-label={untimedInTimeLens ? "No specific timing — ordered by sequence" : undefined}
        className={cn(
          "relative",
          untimedInTimeLens && "border-l-2 border-dashed border-amber-400/70",
          showParagraphBoundary && "mt-3",
        )}
      >
        {untimedInTimeLens && (
          <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-amber-400/15 px-1 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            no timing
          </span>
        )}
        {showParagraphBoundary && (
          <div className={`grid ${gridCols} border-t border-border/60`}>
            <div className="flex items-center justify-center py-1" title="New paragraph">
              <Pilcrow className="h-3 w-3 text-muted-foreground" />
            </div>
          </div>
        )}
        <MemoizedRow
          key={cell.id}
          project={project}
          cell={cell}
          isEditorActive={activeEditorCellId === cell.id}
          onActivateEditor={handleActivateEditor}
          onDeactivateEditor={handleDeactivateEditor}
          isStaleSource={staleCellIds?.has(cell.id) ?? false}
          isUpstreamStaleSource={upstreamStaleCellIds?.has(cell.id) ?? false}
          username={username}
          activeLane={activeLane}
          editable={canEdit}
          canValidate={canValidate}
          canEditSource={canEditSource}
          sourceReadOnlyReason={sourceReadOnlyReason}
          onCellCommitted={onCellCommitted}
          getPendingTargetEventId={getPendingTargetEventId}
          onOptimisticEdit={onOptimisticEdit}
          lockHolderLabel={cellLockHolders?.get(cell.id) ?? null}
          presenceStore={presenceStore}
          remoteChangedWhileFocused={cellsWithRemoteChange?.has(cell.id) ?? false}
          onClaimCell={onClaimCell}
          onReleaseCell={onReleaseCell}
          onTargetPresenceSelection={onTargetPresenceSelection}
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
          onCompleteParagraph={onCompleteParagraph}
          paragraphGroupSize={paragraphGroupInfo?.size}
          paragraphDraftableCount={paragraphGroupInfo?.draftableCount}
          paragraphGroupMemberIds={paragraphGroupInfo?.memberIds}
          isBacktranslationConfigured={isBacktranslationConfigured}
          backtranslating={backtranslating}
          backtranslationErrors={backtranslationErrors}
          onBacktranslate={onBacktranslate}
          onSaveBacktranslation={onSaveBacktranslation}
          getStatisticalBt={getStatisticalBt}
          getFootnoteDetails={getFootnoteDetails}
          cellOpenCommentCount={cellOpenCommentCount}
          activeCueIndex={activeCueIndex}
          onSeekToCue={onSeekToCue}
          rowIndex={index}
          contentNumber={sequentialNumberByCellId.get(cell.id) ?? index + 1}
          lineNumbersEnabled={lineNumbersEnabled}
          scriptureNumbering={chapterNavigationItems.length > 0}
          cellLabelsEnabled={cellLabelsEnabled}
          sourceDirectionMode={sourceDirectionMode}
          targetDirectionMode={targetDirectionMode}
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
          checkLockHolder={checkLockHolder}
          showFootnotesInline={showFootnotesInline}
          footnotePanelActive={footnotePanelActive}
          footnoteViewMode={footnoteViewMode}
          onFootnoteHoverChange={setHoveredFootnote}
          onFootnoteCreated={onFootnoteCreated}
          sourceFootnoteNumberOffset={footnoteOffsets.source}
          targetFootnoteNumberOffset={footnoteOffsets.target}
        />
      </div>
          )
        }}
      </CellStoreRow>
    )
  }, [
    activeCueIndex,
    activeEditorCellId,
    activeLane,
    audioByCellId,
    audioLens,
    backtranslationByCellId,
    backtranslating,
    backtranslationErrors,
    canEdit,
    canEditSource,
    canValidate,
    cellStore,
    cellLockHolders,
    cellOpenCommentCount,
    cellsWithRemoteChange,
    checkLockHolder,
    completing,
    displayCellIds,
    errors,
    examples,
    footnotePanelActive,
    footnoteViewMode,
    getTokenForFile,
    getAlignmentModel,
    getStatisticalBt,
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
    chapterNavigationItems.length,
    sequentialNumberByCellId,
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
    onCompleteParagraph,
    paragraphGroupInfoByCellId,
    onFootnoteCreated,
    onJumpToCell,
    onOpenAudioSetup,
    getPendingTargetEventId,
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
    sourceDirectionMode,
    sourceTextDirection,
    staleCellIds,
    upstreamStaleCellIds,
    targetFontSize,
    targetDirectionMode,
    targetTextDirection,
    username,
  ])
  const listExtraData = useMemo(
    () => ({ cellStoreVersion, renderListItem }),
    [cellStoreVersion, renderListItem],
  )

  return (
    <div className="flex h-full min-h-0 flex-col" onMouseUp={handleMouseUp}>
      <div className="shrink-0 bg-background">
        {/* FRO-273: role badge — shown for read-only roles (viewer/commenter/reviewer) */}
        {readOnlyLabel && (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-shrink-0"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            {readOnlyLabel}
          </div>
        )}
        {chapterNavigationItems.length > 0 && activeChapterLabel && (
          <div className="border-b border-border bg-background/90 px-4 py-2 backdrop-blur-xl">
            <ChapterNavigator
              chapters={chapterNavigationItems}
              activeLabel={activeChapterLabel}
              onSelect={handleChapterSelect}
            />
          </div>
        )}
        <div className={cn("grid gap-2 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground", gridCols)}>
          <div aria-hidden="true" />
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
            {/* AQU-602 / AQU-583: the target-language tag doubles as the lane
                switcher AND the entry point to change the target language.
                • >1 lane (+ change handler) → a dropdown that switches the active
                  lane; with `onEditTargetLanguage` it also gets a "Change target
                  language…" item so the language is reachable here, not buried in
                  Settings. The switcher does NOT require a default target to be
                  set — with extra lanes registered but no default language yet the
                  dropdown still opens (trigger reads "Set target language"), so the
                  named lanes stay reachable and the default can be set from here.
                • otherwise, with `onEditTargetLanguage` → a clickable pill (or a
                  "Set target language" prompt when none is set yet) opening the
                  language settings.
                • with neither handler → the original static pill (byte-identical
                  to the pre-AQU-583 header for callers that pass no handlers).
                AQU-608: lane switching is a maintainer-and-above affordance —
                below maintainer the tag stays a static pill so translators keep
                to their assigned lane. */}
            {lanes &&
            lanes.length > 1 &&
            onLaneChange &&
            canSwitchLanes(project.syncRole?.level) ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      data-testid="lane-switcher"
                      data-active-lane={activeLane}
                      aria-label="Active translation lane"
                      className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  }
                >
                  {/* AQU-583: on the default lane with no project target set,
                      `project.targetLanguage` is empty — prompt to set one rather
                      than showing a blank pill. A named lane always has a tag. */}
                  {project.targetLanguage || "Set target language"}
                  <ChevronDown className="h-2.5 w-2.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[8rem]">
                  {/* Active lanes, shown by default. */}
                  {laneSwitcher.visible.map((lane) => {
                    const active = lane === activeLane
                    const label = lane === "" ? (defaultLaneLabel || "Target") : lane
                    return (
                      <DropdownMenuItem
                        key={lane || "__default__"}
                        data-testid={`lane-option-${lane}`}
                        data-active={active ? "true" : undefined}
                        onClick={() => onLaneChange(lane)}
                        className="justify-between gap-2 text-xs"
                      >
                        {label}
                        {active && <Check className="h-3.5 w-3.5" />}
                      </DropdownMenuItem>
                    )
                  })}
                  {/* AQU-601: archived lanes are hidden behind a reveal so a
                      retired lane stops cluttering the switcher yet stays
                      reachable. If the active lane is itself archived we expand
                      automatically so the current selection is always visible. */}
                  {laneSwitcher.archived.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      {showArchivedLanes || isLaneArchived(activeLane, archivedLanes) ? (
                        laneSwitcher.archived.map((lane) => {
                          const active = lane === activeLane
                          return (
                            <DropdownMenuItem
                              key={lane}
                              data-testid={`lane-option-${lane}`}
                              data-active={active ? "true" : undefined}
                              data-archived="true"
                              onClick={() => onLaneChange(lane)}
                              className="justify-between gap-2 text-xs text-muted-foreground"
                            >
                              <span className="flex items-center gap-1.5">
                                <Archive className="h-3 w-3" />
                                {lane}
                              </span>
                              {active && <Check className="h-3.5 w-3.5" />}
                            </DropdownMenuItem>
                          )
                        })
                      ) : (
                        <DropdownMenuItem
                          data-testid="lane-show-archived"
                          closeOnClick={false}
                          onClick={() => setShowArchivedLanes(true)}
                          className="gap-1.5 text-xs text-muted-foreground"
                        >
                          <Archive className="h-3 w-3" />
                          Show archived ({laneSwitcher.archived.length})
                        </DropdownMenuItem>
                      )}
                    </>
                  )}
                  {/* AQU-583: manage the default target language from the switcher. */}
                  {onEditTargetLanguage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        data-testid="edit-target-language"
                        onClick={onEditTargetLanguage}
                        className="gap-2 text-xs"
                      >
                        <Languages className="h-3.5 w-3.5" />
                        Change target language…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : onEditTargetLanguage ? (
              <button
                type="button"
                data-testid="edit-target-language"
                onClick={onEditTargetLanguage}
                aria-label={project.targetLanguage ? "Change target language" : "Set target language"}
                className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {project.targetLanguage || "Set target language"}
                <Languages className="h-2.5 w-2.5" />
              </button>
            ) : project.targetLanguage ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                {project.targetLanguage}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {displayCellIds.length > 0 ? (
        <div
          ref={listRootRef}
          className="flex min-h-0 flex-1"
          onPointerDownCapture={handleChapterListPointerDownCapture}
          onWheelCapture={clearChapterNavigationSelection}
          onKeyDownCapture={handleChapterListKeyDownCapture}
        >
          <LegendList
            ref={listRef}
            refScrollView={setListScrollElement}
            data={displayCellIds}
            dataVersion={cellStoreVersion}
            renderItem={renderListItem}
            extraData={listExtraData}
            keyExtractor={(cellId) => cellId}
            estimatedItemSize={ESTIMATED_ROW_HEIGHT_PX}
            drawDistance={LEGEND_LIST_DRAW_DISTANCE_PX}
            recycleItems
            maintainVisibleContentPosition
            onScroll={handleListScroll}
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
          <div className="flex-1">
            <EmptyState
              variant="inline"
              className="h-full py-10"
              icon={audioLens ? Music : FileText}
              title={audioLens ? "No media segments yet" : "No text segments in this file"}
              description={
                audioLens
                  ? "Import an audio or video file, or record a take, to populate the media layer."
                  : undefined
              }
            />
          </div>
        )
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
})

interface CellStoreRowProps {
  cellId: string
  cellStore: CellStore
  audioEntry?: CellAudioEntry
  backtranslationText?: string
  projectId?: string | null
  children: (cell: CellData) => React.ReactNode
}

function CellStoreRow({
  cellId,
  cellStore,
  audioEntry,
  backtranslationText,
  projectId,
  children,
}: CellStoreRowProps) {
  const cell = useCellView(cellStore, cellId)
  const hydratedCell = useMemo(() => {
    if (!cell) return null
    return applyRowOverlays(cell, { audioEntry, backtranslationText, projectId })
  }, [audioEntry, backtranslationText, cell, projectId])

  if (!hydratedCell) return null
  return <>{children(hydratedCell)}</>
}

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
  /** AQU-538: active target lane, carried into target-side emits. */
  activeLane: string
  editable: boolean
  /** FRO-273: reviewer (300) can validate but not edit. True whenever role ≥ REVIEWER. */
  canValidate: boolean
  /** True when the user may edit SOURCE text (source.cell.commit): cloud
   *  project_lead+ (500) on a non-live-linked project. See canEditSource. */
  canEditSource: boolean
  /** Why the source lane is force-locked (DCS pin), or null. Shown where the
   *  pencil would be, and surfaced when a mid-edit capability flip force-closes
   *  an open source editor. See useProjectPermissions.sourceReadOnlyReason. */
  sourceReadOnlyReason: string | null
  /** Phase 5 / AD-9: source has advanced since this target was last committed.
   *  Resolved once per file by the parent (membership look-up) so this prop
   *  is just a stable boolean — preserves the row's React.memo invariant. */
  isStaleSource: boolean
  /** FRO-477 (§6): this cell's ANCESTRY is stale (a further-upstream chain
   *  hop changed). Same "stable boolean, resolved by the parent" shape as
   *  `isStaleSource` above. */
  isUpstreamStaleSource: boolean
  onCellCommitted?: (cellId: string, committedEventId?: string, parentId?: string | null) => void | Promise<void>
  getPendingTargetEventId?: (cellId: string) => string | null
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  lockHolderLabel: string | null
  presenceStore?: ProjectPresenceStore | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
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
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<void>
  /** p1-paragraph-ui-wiring: draft the whole paragraph group. Omit to hide the rail button. */
  onCompleteParagraph?: (cellId: string) => void
  /** p1-paragraph-ui-wiring: this cell's paragraph group size — set ONLY when
   *  `cell.paragraphStart === true` (computed by the parent from the ordered
   *  cell list). undefined ⇒ not a paragraph start, or a 1-cell group. */
  paragraphGroupSize?: number
  /** p1-paragraph-ui-wiring (coordinator follow-up): non-validated cell count
   *  in this cell's paragraph group — drives the confirm dialog's truthful
   *  "N of M" copy and the button's hide-when-nothing-to-draft gate. Set
   *  alongside `paragraphGroupSize`. */
  paragraphDraftableCount?: number
  /** p1-paragraph-ui-wiring (coordinator follow-up): every cell id in this
   *  cell's paragraph group (including itself) — MemoizedRow-only, used to
   *  derive `paragraphGroupInFlight` from the `completing` map. Never
   *  forwarded to EditorRow (which gets the derived boolean instead, keeping
   *  its prop surface a stable scalar). */
  paragraphGroupMemberIds?: string[]
  isBacktranslationConfigured?: boolean
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  getStatisticalBt?: (translatedText: string) => string
  getFootnoteDetails: (cellId: string) => CellFootnoteDetails
  cellOpenCommentCount?: Map<string, number>
  activeCueIndex?: number
  onSeekToCue?: (cellId: string) => void
  rowIndex: number
  /** AQU-610: 1-based ordinal among numbered (non-paratext) cells for sequential numbering. */
  contentNumber: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
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
  /** Scripture files number verse rows by canonical ref and leave headings unnumbered. */
  scriptureNumbering: boolean
}

const MemoizedRow = React.memo(function MemoizedRow(props: MemoizedRowProps) {
  const {
    cell, examples, completing, errors, previews, healthMap, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount,
    activeCueIndex, rowIndex, contentNumber, gridCols,
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
    project, username, activeLane, editable, canValidate, canEditSource, sourceReadOnlyReason, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle, onCompleteParagraph, paragraphGroupSize,
    paragraphDraftableCount, paragraphGroupMemberIds,
    isBacktranslationConfigured, onBacktranslate, onSaveBacktranslation, getStatisticalBt,
    getFootnoteDetails,
    onSeekToCue, lineNumbersEnabled, scriptureNumbering, cellLabelsEnabled,
    sourceDirectionMode, targetDirectionMode, sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, micDenied, onProjectChanged, onAddConceptFromSelection, onAskAiFromSelection, onAssignVoice,
    audioLens, onOpenAudioSetup,
    onCellCommitted, getPendingTargetEventId, onOptimisticEdit, lockHolderLabel, presenceStore, remoteChangedWhileFocused,
    onClaimCell, onReleaseCell, onTargetPresenceSelection, onAckRemoteChange,
    isStaleSource,
    isUpstreamStaleSource,
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
  // p1-paragraph-ui-wiring (coordinator follow-up): true while ANY cell in
  // this row's paragraph group is ACTIVELY completing — not just this row's
  // own (a validated start cell never gets one post-skip, so relying on
  // `isLoading` alone would let a second click re-fire completeParagraph
  // mid-fan-out). Only paragraph-start rows with a >1-cell group carry
  // `paragraphGroupMemberIds`; every other row's guard is trivially false.
  // Matches `isLoading`'s value check above (searching/generating only) —
  // presence alone is wrong: a stuck "error" entry (none of useCompletion's
  // three catch paths clear it) would otherwise permanently disable/pulse
  // the button for that group.
  const paragraphGroupInFlight = useMemo(
    () => paragraphGroupMemberIds?.some((id) => {
      const state = completing.get(id)
      return state === "searching" || state === "generating"
    }) ?? false,
    [paragraphGroupMemberIds, completing],
  )
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
        activeLane={activeLane}
        editable={editable}
        canValidate={canValidate}
        canEditSource={canEditSource}
        sourceReadOnlyReason={sourceReadOnlyReason}
        isStaleSource={isStaleSource}
        isUpstreamStaleSource={isUpstreamStaleSource}
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
        onCompleteParagraph={onCompleteParagraph}
        paragraphGroupSize={paragraphGroupSize}
        paragraphDraftableCount={paragraphDraftableCount}
        paragraphGroupInFlight={paragraphGroupInFlight}
        isBacktranslationConfigured={isBacktranslationConfigured}
        isBacktranslating={isBacktranslating}
        backtranslationError={backtranslationError}
        onBacktranslate={onBacktranslate}
        onSaveBacktranslation={onSaveBacktranslation}
        getStatisticalBt={getStatisticalBt}
        getFootnoteDetails={getFootnoteDetails}
        openCommentCount={openCommentCount}
        isActiveCue={isActiveCue}
        onSeekToCue={onSeekToCue}
        rowIndex={rowIndex}
        contentNumber={contentNumber}
        lineNumbersEnabled={lineNumbersEnabled}
        scriptureNumbering={scriptureNumbering}
        cellLabelsEnabled={cellLabelsEnabled}
        sourceDirectionMode={sourceDirectionMode}
        targetDirectionMode={targetDirectionMode}
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
        getPendingTargetEventId={getPendingTargetEventId}
        onOptimisticEdit={onOptimisticEdit}
        lockHolderLabel={lockHolderLabel}
        presenceStore={presenceStore}
        remoteChangedWhileFocused={remoteChangedWhileFocused}
        onClaimCell={onClaimCell}
        onReleaseCell={onReleaseCell}
        onTargetPresenceSelection={onTargetPresenceSelection}
        onAckRemoteChange={onAckRemoteChange}
        sourceFontSize={sourceFontSize}
        targetFontSize={targetFontSize}
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
  /** AQU-538: active target lane. Passed into `target.cell.commit` and
   *  validate/unvalidate emits as `targetLang` (`''` omitted on the wire). */
  activeLane: string
  editable: boolean
  /** FRO-273: reviewer (300) can validate but not edit. True whenever role ≥ REVIEWER. */
  canValidate: boolean
  /** True when the user may edit SOURCE text (source.cell.commit): cloud
   *  project_lead+ (500) on a non-live-linked project. Surfaces the per-cell
   *  "Edit source" affordance. See useProjectPermissions.canEditSource. */
  canEditSource: boolean
  /** Why the source lane is force-locked (DCS pin), or null. Renders a lock
   *  hint where the pencil would be and is the message shown when a mid-edit
   *  capability flip force-closes the source editor. */
  sourceReadOnlyReason: string | null
  /** Phase 5 / AD-9 — true when the source has advanced since the last
   *  target commit. Renders a small warning badge next to the validation
   *  status. Computed once-per-file by the parent. */
  isStaleSource: boolean
  /** FRO-477 (§6) — true when this cell's ANCESTRY is stale (a further-
   *  upstream chain hop changed). Renders the violet/dotted second tone.
   *  Same once-per-file computation shape as `isStaleSource`. */
  isUpstreamStaleSource: boolean
  onCellCommitted?: (cellId: string, committedEventId?: string, parentId?: string | null) => void
  getPendingTargetEventId?: (cellId: string) => string | null
  onOptimisticEdit?: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  lockHolderLabel: string | null
  presenceStore?: ProjectPresenceStore | null
  remoteChangedWhileFocused: boolean
  onClaimCell?: (cellId: string) => void
  onReleaseCell?: (cellId: string) => void
  onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
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
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<void>
  /** p1-paragraph-ui-wiring: draft the whole paragraph group. Omit to hide the rail button. */
  onCompleteParagraph?: (cellId: string) => void
  /** p1-paragraph-ui-wiring: this cell's paragraph group size — set ONLY when
   *  `cell.paragraphStart === true`. undefined ⇒ not a start, or a 1-cell group. */
  paragraphGroupSize?: number
  /** p1-paragraph-ui-wiring (coordinator follow-up): non-validated cell count
   *  in the group — drives the confirm dialog's truthful "N of M" copy and
   *  the button's hide-when-nothing-to-draft gate. */
  paragraphDraftableCount?: number
  /** p1-paragraph-ui-wiring (coordinator follow-up): true while ANY cell in
   *  the group has an in-flight completion — disables the button and blocks
   *  a duplicate `completeParagraph` call mid-fan-out. */
  paragraphGroupInFlight?: boolean
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  getStatisticalBt?: (translatedText: string) => string
  getFootnoteDetails: (cellId: string) => CellFootnoteDetails
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
  /** AQU-610: 1-based ordinal among numbered (non-paratext) cells for sequential numbering. */
  contentNumber: number
  lineNumbersEnabled: boolean
  /** Scripture files number verse rows by canonical ref and leave headings unnumbered. */
  scriptureNumbering: boolean
  cellLabelsEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
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

function humanFootnoteCellRef(cell: CellData): string {
  const value = (cell.group || cell.context || "").trim()
  if (!value || looksLikeUuid(value)) return ""
  return value
}

function footnoteMarkerOptions(
  targetText: string,
  anchor: FootnoteInsertionAnchor | null,
  numberOffset: number,
): Record<FootnoteMarkerStyle, AddFootnoteMarkerOption> {
  const targetFootnotes = extractUsfmFootnotes(targetText)
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

interface RemotePresenceOverlayItem {
  key: string
  kind: "selection" | "caret" | "label"
  username: string
  color: string
  style: React.CSSProperties
}

function RemoteTargetPresenceOverlay({
  contentRef,
  peers,
}: {
  contentRef: React.RefObject<HTMLElement | null>
  peers: CellPresencePeer[]
}) {
  const [items, setItems] = useState<RemotePresenceOverlayItem[]>([])

  useLayoutEffect(() => {
    const root = contentRef.current
    const container = root?.parentElement
    if (!root || !container || peers.length === 0) {
      setItems((current) => current.length === 0 ? current : [])
      return
    }

    const next: RemotePresenceOverlayItem[] = []
    const containerRect = container.getBoundingClientRect()
    for (const peer of peers) {
      const selection = peer.selection
      if (!selection || selection.side !== "target") continue
      const anchor = Math.max(0, selection.anchor)
      const head = Math.max(0, selection.head)
      const start = Math.min(anchor, head)
      const end = Math.max(anchor, head)
      const caretRect = rectForCaretOffset(root, end)
      if (start !== end) {
        const range = rangeForPlainOffsets(root, start, end)
        if (range) {
          Array.from(range.getClientRects()).forEach((rect, index) => {
            if (rect.width <= 0 || rect.height <= 0) return
            next.push({
              key: `${peer.peerId}-selection-${index}`,
              kind: "selection",
              username: peer.username,
              color: peer.color,
              style: {
                left: rect.left - containerRect.left,
                top: rect.top - containerRect.top,
                width: rect.width,
                height: rect.height,
                backgroundColor: peer.color,
              },
            })
          })
        }
      }
      if (caretRect) {
        const left = caretRect.left - containerRect.left
        const top = caretRect.top - containerRect.top
        const height = Math.max(16, caretRect.height)
        next.push({
          key: `${peer.peerId}-caret`,
          kind: "caret",
          username: peer.username,
          color: peer.color,
          style: {
            left,
            top,
            height,
            backgroundColor: peer.color,
          },
        })
        next.push({
          key: `${peer.peerId}-label`,
          kind: "label",
          username: peer.username,
          color: peer.color,
          style: {
            left: left + 3,
            top: Math.max(0, top - 18),
            backgroundColor: peer.color,
          },
        })
      }
    }
    setItems(next)
  }, [contentRef, peers])

  if (items.length === 0) return null

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {items.map((item) => {
        if (item.kind === "selection") {
          return (
            <span
              key={item.key}
              className="absolute rounded-[2px] opacity-20"
              style={item.style}
            />
          )
        }
        if (item.kind === "caret") {
          return (
            <span
              key={item.key}
              className="absolute w-0.5 rounded-full"
              style={item.style}
            />
          )
        }
        return (
          <span
            key={item.key}
            className="absolute max-w-28 truncate rounded px-1 py-px text-[10px] font-medium leading-4 text-white shadow-sm"
            style={item.style}
          >
            {item.username}
          </span>
        )
      })}
    </div>
  )
}

function rangeForPlainOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const startPos = textNodePositionForOffset(root, start)
  const endPos = textNodePositionForOffset(root, end)
  if (!startPos || !endPos) return null
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  return range
}

function rectForCaretOffset(root: HTMLElement, offset: number): DOMRect | null {
  const collapsed = rangeForPlainOffsets(root, offset, offset)
  const collapsedRect = firstUsableRect(collapsed)
  if (collapsedRect) return collapsedRect

  const before = offset > 0 ? rangeForPlainOffsets(root, offset - 1, offset) : null
  const beforeRect = firstUsableRect(before)
  if (beforeRect) {
    return new DOMRect(beforeRect.right, beforeRect.top, 0, beforeRect.height)
  }

  const after = rangeForPlainOffsets(root, offset, offset + 1)
  const afterRect = firstUsableRect(after)
  if (afterRect) {
    return new DOMRect(afterRect.left, afterRect.top, 0, afterRect.height)
  }

  return null
}

function firstUsableRect(range: Range | null): DOMRect | null {
  if (!range) return null
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.height > 0) return rect
  }
  const rect = range.getBoundingClientRect()
  return rect.height > 0 ? rect : null
}

function textNodePositionForOffset(
  root: HTMLElement,
  targetOffset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent?.closest("[data-presence-ignore]")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let remaining = Math.max(0, targetOffset)
  let lastText: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    lastText = node
    const length = node.data.length
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
  }
  if (lastText) return { node: lastText, offset: lastText.data.length }
  return null
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
  username, activeLane = "", editable, canValidate, canEditSource, sourceReadOnlyReason, isCompletionConfigured, isCompletionAvailable, isLoading,
  completionPreview, loadingPhase,
  cellExamples, highlights, error, health,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle,
  onCompleteParagraph, paragraphGroupSize, paragraphDraftableCount, paragraphGroupInFlight,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate, onSaveBacktranslation,
  getStatisticalBt,
  getFootnoteDetails,
  openCommentCount,
  isActiveCue: _isActiveCue, onSeekToCue,
  onDragStart, onDragEnter, onSelectionPointerDown, onNavigateCell,
  onEscapeToGrid, onGridRowKeyNav,
  rowIndex, contentNumber, lineNumbersEnabled, scriptureNumbering, cellLabelsEnabled, sourceDirectionMode, targetDirectionMode, sourceTextDirection, targetTextDirection, gridCols,
  isAnonymous, micDenied,
  audioLens, onOpenAudioSetup, onAssignVoice, onAddConceptFromSelection, onAskAiFromSelection,
  onCellCommitted, getPendingTargetEventId, onOptimisticEdit, lockHolderLabel, presenceStore, remoteChangedWhileFocused,
  onClaimCell, onReleaseCell, onTargetPresenceSelection, onAckRemoteChange,
  isStaleSource,
  isUpstreamStaleSource,
  getAlignmentModel,
  onAlignmentSeedChange,
  sourceFontSize = 14,
  targetFontSize = 14,
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
  const { onInfractionClick, onOpenComments, onOpenHistory, onAiSetupNeeded, onOpenRecording, myScopes } = useEditorActions()
  // AQU-633: a scoped member can only validate cells in their assigned lane/file.
  // Combine the role capability with the per-cell scope check so an out-of-scope
  // cell greys the toggle instead of offering a guaranteed-403 validate. Unscoped
  // members (empty scopes) → always in scope, so this is a no-op for them.
  const canValidateThisCell = canValidate && isInMemberScope(myScopes, cell.fileId, activeLane)
  const remoteCellPresence = useCellPresence(presenceStore, cell.id)
  // A focus lock admits one active writer. Prefer its newest ephemeral draft
  // so the read surface and remote caret advance together between commits.
  const remoteDraftText = useMemo(() => {
    let latest: CellPresencePeer | null = null
    for (const peer of remoteCellPresence) {
      if (peer.selection?.draftText === undefined) continue
      if (!latest || peer.lastSeenAt > latest.lastSeenAt) latest = peer
    }
    return latest?.selection?.draftText
  }, [remoteCellPresence])
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [openRuleAnchor, setOpenRuleAnchor] = useState<ViolationAnchor | null>(null)
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
  // Source-edit affordance (project_lead+ on non-live projects). Editing the
  // SOURCE lane emits source.cell.commit — the template-owner correction that
  // propagates to downstream linked projects. `sourceDraft` is a LOCAL optimistic
  // hold of the just-committed text (kept out of the target-only optimistic-shadow
  // machinery in useCells) shown until the projection round-trips.
  const [sourceEditing, setSourceEditing] = useState(false)
  const [sourceDraft, setSourceDraft] = useState<{ value: string; valueHtml: string } | null>(null)
  // Tracks the newest source.cell.commit this row enqueued whose projection
  // head hasn't caught up yet, as { eventId, parentId }. Successive source edits
  // chain onto `eventId`; the reconciling effect below clears it once the
  // projection reaches it (or a different/remote head lands) — crucially WITHOUT
  // regressing it back to the lagging projection head. Mirrors the target-side
  // pendingTargetCommitHeadsRef reconciliation in ProjectWorkspace. AQU-603: the
  // old naive "adopt cell.sourceEventId" effect clobbered the pending head when a
  // lane switch triggered a mid-flight cells revalidate, forking the next edit
  // onto the same parent — which the server's AD-2 first-child guard dropped as a
  // "stale sibling" (server accepted but did not apply).
  const pendingSourceCommitRef = useRef<{ eventId: string; parentId: string | null } | null>(null)
  const sourceColRef = useRef<HTMLDivElement | null>(null)
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
  // p1-paragraph-ui-wiring (Task 3): confirm dialog shown before drafting an
  // entire paragraph group as one unit — always confirms (no "don't ask
  // again" opt-out exists for this multi-cell action, unlike the single-cell
  // Replace confirm above).
  const [showParagraphConfirm, setShowParagraphConfirm] = useState(false)
  // AQU-618: transient "Saved" confirmation shown after a Replace / AI-generate
  // commit resolves, so the translator can see the change landed instead of
  // being left on the (now-closed) dialog wondering whether it persisted.
  const [showSaved, setShowSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const translatedEditorRef = useRef<TranslatedEditorHandle | null>(null)
  const targetReadContentRef = useRef<HTMLDivElement | null>(null)
  const pendingFootnoteAnchorRef = useRef<FootnoteInsertionAnchor | null>(null)
  const [activeFootnoteIndex, setActiveFootnoteIndex] = useState<number | null>(null)
  const [addFootnoteOpen, setAddFootnoteOpen] = useState(false)
  const [addFootnoteDefaults, setAddFootnoteDefaults] = useState<AddFootnoteDialogDefaults>({
    caller: "+",
    ref: "",
    text: "",
  })
  const [localTargetDraft, setLocalTargetDraft] = useState<{ value: string; valueHtml?: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [expansionTab, setExpansionTab] = useState<string>("backtranslation")
  const [btAlignmentOpen, setBtAlignmentOpen] = useState(false)
  const hasSourceFootnoteMarker = (cell.original ?? "").includes("\\f")
  const visibleTranslated = localTargetDraft?.value ?? cell.translated
  const visibleTranslatedHtml = localTargetDraft?.valueHtml ?? cell.translatedHtml
  const hasTranslatedText = Boolean(visibleTranslated?.trim())
  const showCompletionOverlay = isLoading && !hasTranslatedText
  const sourceCellDirection = useMemo(
    () => resolveTextDirection(sourceDirectionMode, cell.originalHtml ?? cell.original, sourceTextDirection),
    [sourceDirectionMode, sourceTextDirection, cell.originalHtml, cell.original],
  )
  const targetCellDirection = useMemo(
    () => resolveTextDirection(
      targetDirectionMode,
      showCompletionOverlay ? (completionPreview ?? "") : (visibleTranslatedHtml ?? visibleTranslated),
      targetTextDirection,
    ),
    [targetDirectionMode, targetTextDirection, showCompletionOverlay, completionPreview, visibleTranslatedHtml, visibleTranslated],
  )
  const hasTargetFootnoteMarker = (visibleTranslated ?? "").includes("\\f")
  const mayHaveFootnotes = hasSourceFootnoteMarker || hasTargetFootnoteMarker
  const showFootnotesInExpansion = footnoteViewMode === "off" && mayHaveFootnotes
  const shouldHydrateFootnotes =
    showFootnotesInline ||
    (expanded && expansionTab === "footnotes" && showFootnotesInExpansion)
  const allFootnotes = useMemo(
    () => shouldHydrateFootnotes ? getFootnoteDetails(cell.id) : EMPTY_CELL_FOOTNOTE_DETAILS,
    [cell.id, cell.original, visibleTranslated, getFootnoteDetails, shouldHydrateFootnotes],
  )
  const sourceDisplayFootnotes = useMemo(() => {
    if (!shouldHydrateFootnotes || !hasSourceFootnoteMarker) return EMPTY_EXTRACTED_FOOTNOTES
    const segments = segmentUsfmForDisplay(cell.original ?? "")
    if (!segments) return EMPTY_EXTRACTED_FOOTNOTES
    return segments
      .filter((segment): segment is UsfmNoteSegment => segment.kind === "note")
      .map((note) => ({
        index: note.rawStart,
        raw: note.raw,
        caller: note.caller,
        ref: note.ref,
        text: note.text,
      }))
  }, [cell.original, hasSourceFootnoteMarker, shouldHydrateFootnotes])
  const sourceDetailFootnotes = allFootnotes.sourceFootnotes.length > 0
    ? allFootnotes.sourceFootnotes
    : sourceDisplayFootnotes
  const sourceFootnotes = showFootnotesInline ? allFootnotes.sourceFootnotes : EMPTY_EXTRACTED_FOOTNOTES
  const targetFootnotes = showFootnotesInline ? allFootnotes.targetFootnotes : EMPTY_EXTRACTED_FOOTNOTES
  const hasInlineFootnotes = sourceFootnotes.length > 0 || targetFootnotes.length > 0
  const isDocxFile = (cell.fileId ?? "").endsWith(".docx")
  const terminologyConcepts = project.terminology ?? EMPTY_CONCEPTS

  useEffect(() => {
    if (!localTargetDraft) return
    if ((cell.translated ?? "") !== localTargetDraft.value) return
    setLocalTargetDraft(null)
  }, [cell.translated, localTargetDraft])

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
  const targetHasRichFormatting = hasMeaningfulRichText(visibleTranslatedHtml)

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
    setLocalTargetDraft({ value, valueHtml })
    onOptimisticEdit?.(cell.id, { value, valueHtml })
    setWriteError(null)
    // RACE-3/QW-2: use the last event id we enqueued for this cell as parentId
    // rather than the lagging projection value. The workspace-level getter
    // survives Legend List row remounts; the row-local ref covers repeated
    // commits while this exact row instance remains mounted.
    const parentId =
      getPendingTargetEventId?.(cell.id) ??
      pendingTargetEventIdRef.current ??
      cell.targetEventId ??
      cell.sourceEventId ??
      null
    // AQU-538: tag the commit with the active lane. The store now renders this
    // row's ACTIVE-lane target value, so the edited text belongs to `activeLane`.
    // emitTargetCellCommit omits `''` (default lane) on the wire, so N=1 is
    // byte-identical.
    emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value,
      valueHtml,
      author: username,
      targetLang: activeLane,
    }).then((eventId) => {
      pendingTargetEventIdRef.current = eventId
      // Restore codex behaviour: a direct human edit auto-validates the cell
      // ("a human has touched it"). The target.cell.commit above cleared any
      // prior validators (audit-stats-overlay resets activeValidators on every
      // edit), so we re-add the current user against the JUST-committed event
      // id — a cell.validate only sticks when its editEventId matches the
      // cell's latest edit. cell.validate needs only REVIEWER (≤ the CONTRIBUTOR
      // floor already required to reach this commit path), so anyone who can
      // edit can validate; guard defensively anyway. Skip empty commits so
      // clearing a cell doesn't mark an empty row "validated".
      // AQU-633: auto-validate-on-edit IS self-validation (you just authored the
      // cell), so honor the project's allowSelfValidation rule. When it's off,
      // your own work must wait for someone else — don't auto-validate. The
      // server's self-check reads cells.last_editor, which isn't committed yet
      // for this same-action commit+validate, so it can't catch this; the gate
      // has to be here. Default/undefined = allowed, preserving codex behavior.
      if (shouldAutoValidateHumanEdit({
        value,
        canValidate,
        allowSelfValidation: project.allowSelfValidation,
        roleLevel: project.syncRole?.level ?? null,
      })) {
        void emitCellValidate({
          projectId: project.id,
          fileId: cell.fileId,
          cellId: cell.id,
          editEventId: eventId,
          author: username,
        }).catch((err) => {
          // Telemetry-adjacent, non-blocking: the commit already landed.
          console.warn("[auto-validate] emit failed:", err)
        })
      }
      // Pass the just-assigned event id: the auto-BT in the parent pins to it
      // so the BT describes THIS commit, not the lagging projection head.
      void onCellCommitted?.(cell.id, eventId, parentId)
    }).catch((err) => {
      // RES-4/M1-3: enqueue failure (IDB quota, private-mode, InsufficientRoleError)
      // must be loud. Revert the optimistic patch so the cell doesn't show
      // "saved" styling for an event that exists nowhere durable.
      console.error("[editor-commit] enqueue failed:", err)
      const msg = err instanceof Error ? err.message : "Could not save — please try again"
      setWriteError(msg)
      setLocalTargetDraft(null)
      // Revert the optimistic patch to the last confirmed projection value.
      onOptimisticEdit?.(cell.id, {
        value: cell.translated ?? "",
        valueHtml: cell.translatedHtml ?? "",
      })
    })
  }, [editable, canValidate, project.id, project.syncRole?.level, project.allowSelfValidation, cell.fileId, cell.id, cell.targetEventId, cell.translated, cell.translatedHtml, cell.sourceEventId, username, activeLane, onCellCommitted, getPendingTargetEventId, onOptimisticEdit, lockHolderLabel, checkLockHolder])

  // AQU-618: run a single-cell AI generate/Replace, then return the translator
  // to the edited cell and confirm the save. Both entry points — the Replace
  // confirm dialog and the direct sparkle on an empty cell — used to fire
  // `onCompleteSingle` and leave focus on the dialog / rail button with no
  // saved signal, so testers re-applied the change unsure it had persisted.
  // We await the commit (completeSingle auto-commits and flushes the outbox),
  // then re-focus the cell editor (the new text is now visible there) and show
  // a brief "Saved" confirmation.
  const completeSingleAndReturn = useCallback(async () => {
    await onCompleteSingle(cell)
    onActivateEditor(cell.id)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setShowSaved(true)
    savedTimerRef.current = setTimeout(() => {
      setShowSaved(false)
      savedTimerRef.current = null
    }, 2400)
  }, [onCompleteSingle, cell, onActivateEditor])

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
  }, [])

  // Source-edit commit path. The inline source editor (a plain TranslatedEditor)
  // calls this on idle/blur with the current source `{value, valueHtml}`. We emit
  // a `source.cell.commit` chained off the source row's head (AD-2). No AD-9 pin —
  // source rows are the pin target, not the pinned. The server enforces the
  // PROJECT_LEAD floor and the live-mode mirror lock; `enqueueEvent` also mirrors
  // the role floor client-side (InsufficientRoleError).
  const handleSourceCommit = useCallback(({ value, valueHtml }: { value: string; valueHtml: string }) => {
    if (!canEditSource || !project.id) return
    // Belt-and-suspenders role-mirror (canEditSource already encodes ≥500), in
    // case a role downgrade hasn't propagated to the capability yet.
    if (!canPerform("source.cell.commit", project.syncRole?.level ?? null)) {
      console.warn("[source-edit] aborting: role too low for source.cell.commit")
      return
    }
    // Optimistic local hold so the source column shows the new text immediately
    // (cleared by the effect below once cell.original round-trips).
    setSourceDraft({ value, valueHtml })
    setWriteError(null)
    const parentId = resolveSourceCommitParent(pendingSourceCommitRef.current, cell.sourceEventId ?? null)
    emitSourceCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      value,
      valueHtml,
      author: username,
    }).then((eventId) => {
      pendingSourceCommitRef.current = { eventId, parentId }
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      console.error("[source-edit] enqueue failed:", err)
      const msg = err instanceof Error ? err.message : "Could not save source edit — please try again"
      setWriteError(msg)
      setSourceDraft(null)
    })
  }, [canEditSource, project.id, project.syncRole?.level, cell.fileId, cell.id, cell.sourceEventId, username, onCellCommitted])

  // Reconcile the pending source head against the projection — the mirror of
  // ProjectWorkspace's target-side pendingTargetCommitHeadsRef reconciliation.
  // Clear the pending head ONLY when the projection has caught up to it, or when
  // a DIFFERENT head (a remote/peer source commit, mirror-sync) landed that isn't
  // the parent we chained from — in which case the next edit should chain onto
  // that new projection head. While the projection still lags at our commit's
  // parent, KEEP the pending head so the next edit chains onto it rather than
  // forking a stale sibling onto the same parent (AQU-603). When there is no
  // pending commit, handleSourceCommit falls back to cell.sourceEventId, so a
  // remote head is still adopted correctly.
  useEffect(() => {
    pendingSourceCommitRef.current = reconcilePendingSourceCommit(
      pendingSourceCommitRef.current,
      cell.sourceEventId ?? null,
    )
  }, [cell.sourceEventId])

  // Clear the optimistic source draft once the server projection carries it.
  useEffect(() => {
    if (sourceDraft && (cell.original ?? "") === sourceDraft.value) setSourceDraft(null)
  }, [cell.original, sourceDraft])

  // Force-close an OPEN source editor when canEditSource flips false mid-edit
  // (e.g. a settings revalidate delivers a DCS cursor). Without this the editor
  // stayed mounted but handleSourceCommit's guard silently dropped every commit
  // — the user kept typing into a void. Closing is bounded loss (only the text
  // since the flip moment); the writeError banner says WHY so it isn't silent.
  useEffect(() => {
    if (!sourceEditing || canEditSource) return
    setSourceEditing(false)
    setWriteError(
      sourceReadOnlyReason ??
        "Source editing is no longer available on this project — the source editor was closed.",
    )
  }, [sourceEditing, canEditSource, sourceReadOnlyReason])

  // Focus the inline source editor when entering edit mode (mirrors the target
  // editor's focus effect, but scoped to the source column so it can't grab the
  // target ProseMirror).
  useEffect(() => {
    if (!sourceEditing) return
    let attempts = 0
    let frame = window.requestAnimationFrame(function focusEditor() {
      const pm = sourceColRef.current?.querySelector<HTMLElement>(".ProseMirror")
      if (!pm) {
        if (attempts < 8) {
          attempts += 1
          frame = window.requestAnimationFrame(focusEditor)
        }
        return
      }
      if (document.activeElement !== pm) pm.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sourceEditing])

  // Terminology apply (spec 2c): REPLACE the active target selection with the
  // chosen rendering. The Apply affordance is only surfaced when there was a
  // non-empty selection at chip-click time (see handleTermChipClick), and the
  // selected text is captured in targetSelectionTextRef. We replace the first
  // occurrence of that selected text in the current target plain text. When
  // there is no selection (defensive fallback), we append so the translator
  // can still chain multiple terms. Uses the same commit path as keyboard edits.
  const handleTermApply = useCallback((rendering: string) => {
    const existing = visibleTranslated ?? ""
    const selected = targetSelectionTextRef.current
    let next: string
    if (selected && existing.includes(selected)) {
      next = existing.replace(selected, rendering)
    } else {
      const trimmed = existing.trim()
      next = trimmed ? `${trimmed} ${rendering}` : rendering
    }
    handleEditorCommit({ value: next, valueHtml: next })
  }, [visibleTranslated, handleEditorCommit])

  const captureFootnoteAnchor = useCallback(() => {
    pendingFootnoteAnchorRef.current = translatedEditorRef.current?.getFootnoteInsertionAnchor() ?? null
  }, [])

  const openAddFootnoteDialog = useCallback((defaults?: AddFootnoteDialogDefaults) => {
    if (!pendingFootnoteAnchorRef.current) captureFootnoteAnchor()
    const anchor = pendingFootnoteAnchorRef.current
    const markerOptions = footnoteMarkerOptions(visibleTranslated ?? "", anchor, targetFootnoteNumberOffset)
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
  }, [captureFootnoteAnchor, cell, visibleTranslated, targetFootnoteNumberOffset])

  const handleAddFootnote = useCallback((value: AddFootnoteDialogValue) => {
    const marker = createUsfmFootnoteMarker(value)
    const inserted = translatedEditorRef.current?.insertFootnoteMarker(
      marker,
      pendingFootnoteAnchorRef.current,
    ) ?? false

    if (!inserted) {
      const next = `${visibleTranslated ?? ""}${marker}`
      handleEditorCommit({ value: next, valueHtml: next })
    }

    pendingFootnoteAnchorRef.current = null
    onFootnoteCreated?.()
    setAddFootnoteOpen(false)
  }, [visibleTranslated, handleEditorCommit, onFootnoteCreated])

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
    const completionText = isLoading ? (completionPreview ?? "") : (visibleTranslated ?? "")
    if (!completionText.trim()) return []
    return detectPreAcceptanceWarnings(
      completionText,
      cell.original ?? "",
      terminologyConcepts,
    )
  }, [isLoading, completionPreview, visibleTranslated, cell.original, terminologyConcepts])

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
    // AQU-633: additive lane/file scope guard. A scoped member's validate on an
    // out-of-scope cell is a guaranteed 403 — don't optimistically flip then
    // revert. The toggle is already greyed (canValidateThisCell); this covers
    // keyboard/programmatic triggers too. Unscoped members are always in scope.
    if (!isInMemberScope(myScopes, cell.fileId, activeLane)) {
      console.warn("[validate] aborting: cell out of the caller's assigned scope")
      return
    }
    const editEventId = cell.targetEventId ?? pendingTargetEventIdRef.current
    if (!project.id || !editEventId) return
    setOptimisticSelfValidation(validated)
    // AQU-538: scope the validation to the active lane. emitCellValidate/
    // emitCellUnvalidate omit `''` (default lane) on the wire, so N=1 is
    // byte-identical.
    const emit = validated ? emitCellValidate : emitCellUnvalidate
    void emit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      editEventId,
      author: username,
      targetLang: activeLane,
    }).then(() => {
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      setOptimisticSelfValidation(null)
      console.warn(`[${validated ? "validate" : "unvalidate"}] emit failed:`, err)
      // FRO-274: surface enqueue failure inline.
      setWriteError("Couldn't save this change locally — copy your text and reload.")
    })
  }, [cell.fileId, cell.id, cell.targetEventId, project.id, project.syncRole?.level, username, activeLane, myScopes, onCellCommitted])

  const editorFocusedRef = useRef(false)
  const requestTargetEdit = useCallback(() => {
    if (!editable || isLoading || lockHolderLabel) return
    onActivateEditor(cell.id)
  }, [editable, isLoading, lockHolderLabel, onActivateEditor, cell.id])

  const handleTargetPresenceSelection = useCallback((selection: TargetPresenceSelection | null) => {
    onTargetPresenceSelection?.(cell.id, selection)
  }, [cell.id, onTargetPresenceSelection])

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
  const targetHtml = visibleTranslatedHtml ?? ""
  const targetHasFormatting = /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(targetHtml)
  const showFormattingLossWarning =
    sourceHasFormatting && !targetHasFormatting && visibleTranslated.trim().length > 0

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
  // Round 5: when the rail plays the SHARED source clip (media section), it
  // must stop at the section's end — the play-queue windows this clip, but
  // this per-cell player was never told the window, so play ran on through
  // the rest of the film. Takes and generated clips stay unconstrained.
  const railSectionWindow =
    isSourceSegmentSelected(cell) &&
    typeof cell.startTime === "number" && Number.isFinite(cell.startTime) &&
    typeof cell.endTime === "number" && Number.isFinite(cell.endTime) &&
    cell.endTime > cell.startTime
      ? { start: cell.startTime, end: cell.endTime }
      : null
  const { setTrim: setRailTrim } = audioController
  useEffect(() => {
    if (cell.medium !== "media") return
    if (railSectionWindow) setRailTrim(railSectionWindow.start, railSectionWindow.end)
    else setRailTrim(null, null)
  }, [cell.medium, railSectionWindow?.start, railSectionWindow?.end, setRailTrim]) // eslint-disable-line react-hooks/exhaustive-deps -- window identity varies per render; primitives cover it
  const cellForGeneratedVoice = useMemo(() => ({
    metadata: {
      attachments: cell.attachments,
      selectedAudioId: cell.selectedGeneratedVoiceAudioId,
    },
  } as unknown as import("@/lib/codex-editor/types").CodexCell), [
    cell.attachments, cell.selectedGeneratedVoiceAudioId,
  ])
  const generatedVoiceController = useCellAudio(project, cellForGeneratedVoice, cell.fileId)

  // AQU-521: karaoke-while-listening for the read-only target view. When a cell
  // is not being actively edited its target renders as plain text (not a
  // ProseMirror editor), so the editor's karaoke plugin can't paint the active
  // word. Compute the active word's plain-text offset span from whichever audio
  // is playing (recorded take or generated voice) so KaraokeReadText can paint
  // it as playback advances. Scoped to plain (non-USFM, non-rich) target text —
  // WordTiming offsets are computed against that plain text.
  const targetIsPlainText = useMemo(
    () => !targetHasRichFormatting && segmentUsfmForDisplay(visibleTranslated ?? "") === null,
    [targetHasRichFormatting, visibleTranslated],
  )
  const karaokeReadRange = useMemo(() => {
    if (!targetIsPlainText) return null
    if (audioController.isPlaying) {
      return activeWordRange(cellAudioTimings, audioController.currentTime)
    }
    if (generatedVoiceController.isPlaying) {
      return activeWordRange(generatedVoiceTimings, generatedVoiceController.currentTime)
    }
    return null
  }, [
    targetIsPlainText, cellAudioTimings, generatedVoiceTimings,
    audioController.isPlaying, audioController.currentTime,
    generatedVoiceController.isPlaying, generatedVoiceController.currentTime,
  ])

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
    // AQU-646: the ASR language must match the AUDIO. Imported media segments
    // are SOURCE speech (→ sourceLanguage); recorded takes voice the TARGET
    // text (→ targetLanguage). Mapping to a Whisper tag happens downstream.
    const language = isSourceSegmentSelected(cell) ? project.sourceLanguage : project.targetLanguage
    void transcribeCell({ cell, session: rowSession, projectId: project.id, language })
  }, [cell, rowSession, project.id, project.sourceLanguage, project.targetLanguage])

  const [validationPopoverOpen, setValidationPopoverOpen] = useState(false)
  const authoritativeSelfValidated = cell.activeValidators.includes(username)
  const [optimisticSelfValidation, setOptimisticSelfValidation] = useState<boolean | null>(null)
  useEffect(() => {
    if (optimisticSelfValidation !== null && authoritativeSelfValidated === optimisticSelfValidation) {
      setOptimisticSelfValidation(null)
    }
  }, [authoritativeSelfValidated, optimisticSelfValidation])
  const isSelfValidated = optimisticSelfValidation ?? authoritativeSelfValidated
  const displayedValidators = useMemo(() => {
    if (optimisticSelfValidation === null) return cell.activeValidators
    if (optimisticSelfValidation) {
      return cell.activeValidators.includes(username)
        ? cell.activeValidators
        : [...cell.activeValidators, username]
    }
    return cell.activeValidators.filter((validator) => validator !== username)
  }, [cell.activeValidators, optimisticSelfValidation, username])
  const validationRequirement = readValidationCount(project)
  const vs = optimisticSelfValidation === true
    ? displayedValidators.length >= validationRequirement ? "full-self" : "self"
    : optimisticSelfValidation === false
      ? displayedValidators.length >= validationRequirement ? "full-others" : displayedValidators.length > 0 ? "others" : "none"
      : cell.validationStatus
  const hasValidatorInfo = displayedValidators.length > 0 || cell.validationHistory.length > 1

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
      if (canValidateThisCell && !isSelfValidated) {
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

  const hasContent = Boolean(visibleTranslated && visibleTranslated.trim())

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
  const numberLabel = cellNumberLabel({
    lineNumbersEnabled,
    cellType: cell.type,
    canonicalRef: cell.group,
    sourceCanonicalRef: cell.globalReferences?.[0],
    scriptureNumbering,
    rowIndex,
    contentNumber,
    displayLabel: importDisplayLabel(cell.metadata),
  })
  const numberPill = numberLabel === null ? null : (
    <span className="flex h-6 items-center" aria-label={`Line ${numberLabel}`}>
      <CellNumberPill
        number={numberLabel}
        plain
        tint={hasMajorInfraction ? "major" : hasAnyIssue ? "issue" : "none"}
      />
    </span>
  )

  // ── Hover / focus state for the floating action rail ─────────────────────
  // Browser focus is exclusive, as is the pointer's hovered row. Deriving
  // visibility only from those two sources guarantees one rail normally and
  // at most two while a focused editor remains active and another row is
  // hovered. Do not add a per-row sticky selection latch here: visited rows
  // would accumulate visible rails.
  const [isHovering, setIsHovering] = useState(false)
  const [hasFocusWithin, setHasFocusWithin] = useState(false)
  // AQU-354: does a rail control specifically hold focus? Used to pin the rail
  // open (an in-progress interaction must never be idle-collapsed).
  const [railHasFocus, setRailHasFocus] = useState(false)

  // ── Expansion state ───────────────────────────────────────────────────────
  const alignmentModelForExpansion = useMemo(() => {
    if (!btAlignmentOpen || !expanded || expansionTab !== "backtranslation") return null
    if (!cell.original.trim() || !visibleTranslated.trim()) return null
    return getAlignmentModel?.() ?? null
  }, [btAlignmentOpen, cell.original, visibleTranslated, expanded, expansionTab, getAlignmentModel])

  // Edit history is reached via the single History control on the cell action
  // rail (opens the full HistoryDrawer). The audit trail lives in the
  // sync-worker, not the cell projection, so the drawer fetches the D1 event
  // log on demand — the row itself no longer renders a duplicate inline list.

  // ── Compute attention signals for chevron + tab dots ──────────────────────
  const isBtStale = Boolean(
    cell.backtranslation && cell.backtranslationForText !== visibleTranslated,
  )
  const transcriptText = useMemo(() => {
    if (!cellAudioTimings || cellAudioTimings.length === 0) return ""
    return cellAudioTimings.map((t) => t.word).join(" ")
  }, [cellAudioTimings])
  const transcriptMatchesCellText = useMemo(() => {
    if (!hasAudio || !transcriptText) return true
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
    return norm(transcriptText) === norm(visibleTranslated)
  }, [hasAudio, transcriptText, visibleTranslated])
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

  useEffect(() => {
    if (!expanded || expansionTab !== "backtranslation") setBtAlignmentOpen(false)
  }, [expanded, expansionTab])

  // AQU-354: reveal the rail on the ephemeral triggers, but idle-collapse it
  // after a short pause so it stops covering the "changed elsewhere while you
  // were editing" conflict banner (whose Discard button sits under the rail).
  // Pins (expansion open, a rail control focused, a rail popover open) keep the
  // rail visible so an in-progress interaction is never yanked away.
  const railRevealTriggered = isHovering || hasFocusWithin
  // AQU-621: a focused target cell also pins the rail, so clicking into a cell
  // never leaves the user staring at a blank rail — the sparkle/generate
  // affordance stays visible without hovering (a translated cell keeps its
  // separate validation control beside the target). The lone exception is
  // AQU-354's conflict banner: while a remote change is pending we must NOT pin
  // on focus, or the rail would re-cover the banner's Discard button. See
  // computeRailPinned for the reconciliation.
  const railPinned = computeRailPinned({
    expanded,
    railHasFocus,
    showMicDeniedHelp,
    showGenerateConfirm,
    hasFocusWithin,
    remoteChangedWhileFocused,
  })
  const { revealed: railRevealed, registerActivity: registerRailActivity } = useRailIdleHide({
    revealTriggered: railRevealTriggered,
    pinned: railPinned,
  })

  // ── BT tab edit state ─────────────────────────────────────────────────────
  const [btEditing, setBtEditing] = useState(false)
  const [btEditValue, setBtEditValue] = useState("")
  const [btSaving, setBtSaving] = useState(false)
  // Collapsed-by-default statistical reference. The gloss is corpus-derived
  // and local-only — computed lazily when the section is opened, never
  // persisted as the cell's back-translation.
  const [btStatsOpen, setBtStatsOpen] = useState(false)
  const statisticalGloss = useMemo(() => {
    if (!btStatsOpen || !visibleTranslated.trim()) return ""
    return getStatisticalBt?.(visibleTranslated) ?? ""
  }, [btStatsOpen, visibleTranslated, getStatisticalBt])

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
      // A hand-edited BT is the human's wording, not the model's — persist
      // it unpolished so corrected readings re-seed the statistical glosser.
      onSaveBacktranslation?.(cell, btEditValue.trim(), false)
    } finally {
      setBtSaving(false)
      setBtEditing(false)
    }
  }, [btEditValue, cell, onSaveBacktranslation])

  const handleBtCancel = useCallback(() => {
    setBtEditing(false)
    setBtEditValue("")
  }, [])

  // Stable rail handlers
  const handleRowMouseEnter = () => {
    setIsHovering(true)
    // AQU-354: a fresh hover re-summons the rail if it had idle-collapsed.
    registerRailActivity()
  }
  const handleRowMouseLeave = () => {
    // Clear immediately. A grace timer lets the previous hovered row overlap
    // the next one, producing three rails when an editor is also focused.
    setIsHovering(false)
  }
  const handleRowFocusCapture = () => {
    setHasFocusWithin(true)
    // AQU-354: focusing anything in the row re-summons an idle-collapsed rail.
    registerRailActivity()
  }
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
    // The row is focusable (`tabIndex={0}`), so mouse/touch activation is
    // represented by the same exclusive focus state as keyboard activation.
    registerRailActivity()
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
  // is active so the ViolationPopover can anchor to the clicked blot.
  // Expanding the row re-renders the editor and detaches the blot's DOM node,
  // and a detached anchor makes the popover fall back to the viewport origin —
  // so snapshot the rect and anchor to a virtual element instead.
  const openInlineRule = useCallback((ruleId: string, anchor: HTMLElement) => {
    setExpanded(true)
    setExpansionTab("issues")
    setOpenRuleId(ruleId)
    const rect = anchor.getBoundingClientRect()
    setOpenRuleAnchor({ getBoundingClientRect: () => rect })
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
  const validationTooltip = canValidateThisCell
    ? "Not validated — click to validate"
    : canValidate
      ? "Outside your assigned files or lanes" // AQU-633: scoped-out, not a role gate
      : "Validation unavailable"
  type PreventableReactEvent<T> = React.SyntheticEvent<T> & {
    preventBaseUIHandler?: () => void
  }
  const renderValidationButton = (onClick?: () => void) => (
    <button
      type="button"
      data-showcase="cell.health"
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
      disabled={!canValidateThisCell}
    >
      <HealthRing
        health={healthValue}
        size={22}
        strokeWidth={2}
        className="pointer-events-none"
        style={{ position: "absolute", inset: 0, margin: "auto" }}
      />
      <ValidationIcon
        className="relative h-3.5 w-3.5"
        strokeWidth={2.5}
        {...(vs === "others" ? { fill: "currentColor" } : {})}
      />
    </button>
  )
  // AQU-592: the validation control (health ring + validate toggle, with the
  // validators popover) renders to the LEFT of the TARGET editing cell — see the
  // target column below — instead of in the far-left gutter beside the source.
  // A reviewer no longer has to cross the screen from the target to validate.
  const validationControl = hasContent ? (
    <div className="flex shrink-0 items-start pt-1">
      {hasValidatorInfo ? (
        <Popover open={validationPopoverOpen} onOpenChange={handleOpenChange}>
          <PopoverTrigger
            openOnHover
            delay={400}
            closeDelay={100}
            render={renderValidationButton(
              canValidateThisCell && !isSelfValidated
                ? () => emitValidationChange(true)
                : undefined,
            )}
          />
          {vs !== "empty" && (
            <PopoverContent
              side="right"
              align="start"
              className="w-72 rounded-xl p-2"
            >
              <ul className="space-y-0.5">
                <li className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Validated by
                </li>
                {displayedValidators.length === 0 ? (
                  <li className="px-1 py-1 text-xs text-muted-foreground">No active validators</li>
                ) : (
                  displayedValidators.map((v) => (
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
      ) : (
        <AppTooltip content={validationTooltip}>
          {renderValidationButton(
            canValidateThisCell && !isSelfValidated
              ? () => emitValidationChange(true)
              : undefined,
          )}
        </AppTooltip>
      )}
    </div>
  ) : null
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
        data-cell-expanded={expanded ? "true" : undefined}
        // AQU-590: exposes AI-translation-in-progress on the row itself so the
        // signal is testable and not only carried by a transient CSS ring.
        data-ai-translating={isLoading ? "true" : undefined}
        tabIndex={0}
        aria-label={`${cellRef} cell`}
        className={cn(
          // Flat row in a continuous list: tinted by hover/selection overlays,
          // not shadows. Depth is gone by design — the Linear model reserves
          // elevation for floating layers.
          "group relative grid gap-2 px-4 py-2 transition-colors duration-150 ease-out",
          // The mic-permission help is anchored in the action rail. While it
          // is open, this row must become its own higher stacking layer and
          // allow the popover to escape the row; otherwise neighbouring rows
          // and the sticky table header paint above it.
          showMicDeniedHelp ? "z-30 overflow-visible" : "overflow-hidden",
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
          // AQU-590: same "cell is working" treatment while an AI translation
          // is in progress on this cell. Previously the only in-progress signal
          // was the Queued→Synced outbox chip in the status bar (easy to miss),
          // plus a target-column overlay that is suppressed once the cell
          // already has text (the sparkle regenerate/replace case). A colored,
          // pulsing inset ring anchored to the exact row makes progress evident
          // regardless of existing text or whether the action rail is hovered.
          isLoading && "bg-primary/5 ring-2 ring-primary/50 ring-inset animate-pulse",
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
        {/* Multi-select control — anchored to the FAR LEFT edge of the row
            (inside the row's horizontal padding, before the number gutter) so
            the only affordance between the source and target columns is the
            validation button. */}
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
              "absolute left-1 top-10 z-20 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full border",
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
        {/* Left gutter — a subtle line number sits to the LEFT of the
            validation circle, both anchored to the top of the card. The number
            is the single issue surface (severity tint + title); no
            stripe/dot/warning. Multi-select lives at the far-left row edge so
            only the validation button sits between source and target. */}
        <div className="flex h-full w-full flex-wrap items-start justify-center gap-1 pt-5">
          {numberPill}
          {/* The validation circle moved next to the TARGET editing cell
              (AQU-592); the gutter now carries only the line number and the
              stale-source / synth status affordances. */}
          {/* Stale-source indicator. Both flags
              are already resolved per-row booleans (see isStaleSource's doc
              comment) — the singleton Set(s) just adapt them to the
              indicator's managed-mode membership-set contract. */}
          {(isStaleSource || isUpstreamStaleSource) && hasContent && (
            <StaleSourceIndicator
              cellId={cell.id}
              staleCellIds={isStaleSource ? new Set([cell.id]) : new Set()}
              upstreamStaleCellIds={isUpstreamStaleSource ? new Set([cell.id]) : new Set()}
            />
          )}
          {(isSynthBusy || isSynthError) && (
            <SynthStatusBadge status={synthStatus} cellId={cell.id} projectId={project.id} onOpenAudioSetup={onOpenAudioSetup} />
          )}
          {/* AQU-599: persistent "has comment" indicator. Unlike the action-rail
              comment button (which only appears on hover/focus), this icon stays
              visible in the gutter whenever the cell carries an open comment, so
              comments are discoverable without opening each cell. Clicking it
              opens the comments panel for the cell. */}
          {onOpenComments && openCommentCount > 0 && (
            <AppTooltip content={`${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}`}>
              <button
                type="button"
                aria-label={`${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""} — open comments`}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-blue-500 transition-colors hover:bg-blue-500/10 hover:text-blue-600"
                onClick={() => onOpenComments(cell.id)}
              >
                <MessageCircle className="h-3.5 w-3.5" fill="currentColor" fillOpacity={0.15} />
              </button>
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
            data-showcase="editor.source"
            ref={sourceColRef}
            className={cn(
              // The selection control is centered on the physical divider and
              // protrudes into this column. Reserve enough room for RTL text,
              // whose first glyph sits against this right edge.
              "relative flex flex-col pr-4 transition-opacity",
              isSynthBusy && "opacity-70",
            )}
            dir={sourceCellDirection}
            aria-label="Source text"
            data-cell-type="source"
            style={{ fontSize: `${sourceFontSize}px`, lineHeight: "1.6" }}
            onMouseUp={(!sourceEditing && (onAddConceptFromSelection || onAskAiFromSelection)) ? handleSourceMouseUp : undefined}
          >
            {/* Source-selection toolbar. Appears when source text is selected:
                "Ask AI" pushes the selection into the agent as a context chip,
                "Add to terms" promotes it to a DRAFT concept, and a "View term"
                button appears when the selection matches an active concept. */}
            {sourceSelection && (
              <SourceSelectionToolbar
                sourceSelection={sourceSelection}
                concepts={terminologyConcepts}
                onAskAi={handleAskAiFromSelection}
                onAddToTermbase={onAddConceptFromSelection ? handleAddSelectionToTermbase : undefined}
                onTermApply={handleTermApply}
                onToolbarMouseDown={handleToolbarMouseDown}
                onToolbarMouseUp={handleToolbarMouseUp}
              />
            )}
            <div className="mb-1 flex h-4 items-center justify-center gap-1 text-center text-xs text-muted-foreground" dir="ltr">
              <span>{cell.context}</span>
              {showFormattingLossWarning && (
                <AppTooltip content="Source has inline formatting that the target does not preserve. Formatting will be lost on export." className="max-w-xs">
                  <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    formatting
                  </span>
                </AppTooltip>
              )}
              {/* Source-edit affordance (project_lead+, non-live projects). Emits
                  source.cell.commit — the template-owner correction that propagates
                  downstream. Read-only source stays the default; editing is explicit. */}
              {canEditSource ? (
                <AppTooltip content={sourceEditing ? "Done editing source" : "Edit source text"}>
                  <button
                    type="button"
                    aria-label={sourceEditing ? "Done editing source" : "Edit source text"}
                    aria-pressed={sourceEditing}
                    onClick={() => setSourceEditing((v) => !v)}
                    className={cn(
                      "ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors",
                      sourceEditing
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground/50 opacity-0 hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                    )}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </AppTooltip>
              ) : sourceReadOnlyReason ? (
                // Force-locked source lane (DCS pin): keep an explained
                // affordance where the pencil would be instead of letting it
                // silently vanish (AQU-615 review nit).
                <AppTooltip content={sourceReadOnlyReason} className="max-w-xs">
                  <span
                    aria-label="Source is locked"
                    className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/50 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Lock className="h-3 w-3" />
                  </span>
                </AppTooltip>
              ) : null}
            </div>
            <SourceReferenceAttachments metadata={cell.metadata} />
            {sourceEditing ? (
              <TranslatedEditor
                cellId={`${cell.id}::source`}
                initialPlain={sourceDraft?.value ?? cell.original}
                initialHtml={sourceDraft?.valueHtml ?? cell.originalHtml}
                onCommit={handleSourceCommit}
                onBlur={() => setSourceEditing(false)}
                editable
                ariaLabel="Edit source text"
                placeholder="Source text…"
                className="w-full rounded-lg ring-1 ring-primary/30 focus-within:ring-primary/50"
              />
            ) : (sourceDraft?.valueHtml || cell.originalHtml) ? (
              <SanitizedRichHtml html={sourceDraft?.valueHtml || cell.originalHtml || ""} />
            ) : (
              <UsfmSourceText
                // AQU-646: an imported media segment's stored `value` is the
                // filename; once transcribed, the ASR transcript IS the source
                // text users translate. Non-media cells are unaffected.
                text={
                  cell.medium === "media" && cell.transcription?.trim()
                    ? cell.transcription
                    : (sourceDraft?.value ?? cell.original)
                }
                highlights={highlights}
                ranges={sourceRanges}
                showEvidence={examplesExpanded}
                onRangeClick={openInlineRule}
                concepts={terminologyConcepts}
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
          data-showcase="editor.target"
          className={cn(
            "relative flex flex-col pl-3 pr-9 transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          dir="ltr"
          style={{ fontSize: `${targetFontSize}px`, lineHeight: "1.6" }}
        >
          {/* Header lane — mirrors the source column's context line so the
              target's first text line aligns with the source text, and gives
              the floating action rail a lane of its own instead of letting it
              cover the first line of target text. The cast/character label
              lives here (left side), not squished into the line-number pill. */}
          <div className="mb-1 flex h-4 items-center justify-between gap-2 text-xs text-muted-foreground" dir="ltr">
            {showCellLabel && (
              <AppTooltip content={labelText} disabled={!labelText}>
                <span className="max-w-[60%] truncate">
                  {labelText}
                </span>
              </AppTooltip>
            )}
            {cell.aiDrafted && (
              <Badge
                variant="outline"
                className="ml-auto h-4 shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 px-1.5 text-[9px] font-medium text-amber-700 dark:text-amber-300"
                aria-label="AI draft — individual human review required"
              >
                <Sparkles className="size-2.5" />
                AI draft · review required
              </Badge>
            )}
          </div>
          <div className="flex flex-1 flex-col">
            {/* Target is a cheap read surface at rest. It upgrades to TipTap
                only for the active cell, which keeps scrolling from mounting
                dozens of ProseMirror instances. */}
            {/* AQU-592: the validate button sits to the LEFT of the editing cell
                so validating keeps the reviewer's gaze on the TARGET. */}
            <div className="flex flex-1 gap-1.5">
              {validationControl}
            <div
              data-cell-type="target"
              className={cn(
                "relative flex min-h-[40px] flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors",
                hasInlineFootnotes && "min-h-0 py-0.5",
                "hover:bg-muted/60 focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
                !visibleTranslated?.trim() && "bg-muted/40",
              )}
            >
                {isEditorActive ? (
                  <TranslatedEditor
                    ref={translatedEditorRef}
                    cellId={cell.id}
                    initialPlain={visibleTranslated}
                    initialHtml={visibleTranslatedHtml}
                    onCommit={handleEditorCommit}
                    onFocus={handleEditorFocus}
                    onBlur={handleEditorBlurOuter}
                    onSelectionChange={handleTargetPresenceSelection}
                    textDirection={targetCellDirection}
                    directionMode={targetDirectionMode}
                    lang={project.targetLanguage || undefined}
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
                    terminologyConcepts={terminologyConcepts}
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
                    dir={targetCellDirection}
                    lang={project.targetLanguage || undefined}
                    tabIndex={editable && !isLoading && !lockHolderLabel ? 0 : undefined}
                    className={cn(
                      "relative min-h-[40px] w-full whitespace-pre-wrap rounded-lg px-1 py-0.5 leading-relaxed text-foreground/90 outline-none",
                      "focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1",
                      showCompletionOverlay && "opacity-30 transition-opacity",
                      !visibleTranslated?.trim() && "text-muted-foreground/60",
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
                    <div ref={targetReadContentRef}>
                      {remoteDraftText !== undefined ? (
                        <span data-remote-presence-draft>
                          {remoteDraftText || "\u200b"}
                        </span>
                      ) : targetHasRichFormatting && visibleTranslatedHtml ? (
                        <TargetRichHtml
                          html={visibleTranslatedHtml}
                          footnotePanelActive={footnotePanelActive}
                          footnoteNumberOffset={targetFootnoteNumberOffset}
                        />
                      ) : visibleTranslated?.trim() ? (
                        karaokeReadRange ? (
                          <KaraokeReadText text={visibleTranslated} range={karaokeReadRange} />
                        ) : (
                          <TargetReadText
                            text={visibleTranslated}
                            ranges={targetRanges}
                            concepts={terminologyConcepts}
                            onRangeClick={openInlineRule}
                            onTermChipClick={handleTermChipClick}
                            footnotePanelActive={footnotePanelActive}
                            footnoteNumberOffset={targetFootnoteNumberOffset}
                          />
                        )
                      ) : (
                        <span aria-hidden="true" className="block min-h-[1.6em]" />
                      )}
                    </div>
                    <RemoteTargetPresenceOverlay
                      contentRef={targetReadContentRef}
                      peers={remoteCellPresence}
                    />
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
                const concepts = terminologyConcepts
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
                    <p className="whitespace-pre-wrap px-2 py-1 leading-relaxed text-foreground/90" dir={targetCellDirection}>
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
            </div>
            {hasInlineFootnotes && (
              <FootnoteInline
                sourceFootnotes={sourceFootnotes}
                targetFootnotes={targetFootnotes}
                editable={editable}
                isDocx={isDocxFile}
                onSave={(footnoteIndex, newText) => {
                  const updated = spliceFootnoteText(visibleTranslated ?? "", footnoteIndex, newText)
                  if (updated === null) return false // stale index — keep the editor open (FRO-472)
                  handleEditorCommit({ value: updated, valueHtml: updated })
                }}
                onDelete={(footnoteIndex) => {
                  const updated = deleteFootnote(visibleTranslated ?? "", footnoteIndex)
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
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss"
                  onClick={() => setWriteError(null)}
                  className="shrink-0 text-destructive hover:bg-destructive/20"
                >
                  ✕
                </Button>
              </div>
            )}
            {/* AQU-618: transient saved confirmation after a Replace / AI-generate
                commit. `role="status"` announces it politely; the check + label
                give the sighted translator the "it landed" signal they lacked. */}
            {showSaved && !writeError && (
              <div
                role="status"
                className="mt-1 flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
              >
                <Check className="h-3 w-3" strokeWidth={3} />
                <span>Saved</span>
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
          <div
            className="pointer-events-auto"
            // AQU-354: track focus landing on / leaving a rail control so the
            // idle auto-hide never collapses the rail while it is being used.
            onFocusCapture={() => setRailHasFocus(true)}
            onBlurCapture={(e) => {
              const next = e.relatedTarget as Node | null
              if (next && e.currentTarget.contains(next)) return
              setRailHasFocus(false)
            }}
          >
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
                    // AQU-591: users can opt out of the confirm for
                    // non-validated cells. Validated cells always confirm —
                    // replacing them clears validation, which is more
                    // destructive and always deserves an explicit confirm.
                    if (visibleTranslated.trim()) {
                      const isValidated = cell.status === "validated"
                      if (!isValidated && getSkipReplaceConfirm()) {
                        void completeSingleAndReturn()
                      } else {
                        setShowGenerateConfirm(true)
                      }
                    } else {
                      void completeSingleAndReturn()
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

              {/* p1-paragraph-ui-wiring (Task 3 + coordinator follow-up): draft
                  the whole paragraph as one model call. ALL of the gates below
                  must hold for the button to even render (unlike Sparkles,
                  which stays visible in a disabled/"set up AI" state) — a
                  paragraph-wide action that can't run yet shouldn't invite a
                  click. Hidden when: the group is a single cell (the Sparkles
                  button already covers it), the group has nothing left to
                  draft (every cell already validated — resolves the silent
                  no-op), or the parent didn't wire onCompleteParagraph.
                  `groupBusy` covers BOTH this row's own in-flight state and
                  any OTHER cell in the group still drafting (a validated
                  start cell never gets its own `completing` entry, so relying
                  on `isLoading` alone would let a second click re-fire
                  completeParagraph mid-fan-out). */}
              {cell.paragraphStart === true &&
                editable &&
                !isAnonymous &&
                isCompletionConfigured &&
                isCompletionAvailable &&
                onCompleteParagraph &&
                paragraphGroupSize !== undefined &&
                paragraphGroupSize > 1 &&
                (paragraphDraftableCount ?? 0) > 0 && (() => {
                const groupBusy = paragraphGroupInFlight ?? isLoading
                return (
                  <RailButton
                    icon={<PilcrowRight className="h-3.5 w-3.5" />}
                    tooltip={groupBusy ? "Generating…" : `Draft paragraph (${paragraphGroupSize} cells)`}
                    onClick={() => {
                      if (groupBusy) return
                      setShowParagraphConfirm(true)
                    }}
                    disabled={groupBusy}
                    pulsing={groupBusy}
                  />
                )
              })()}

              {/* AQU-620: Regenerate — ask the AI for another iteration of an
                  existing prediction. Shown only for a NON-validated cell that
                  already has a draft (validated cells route through the Sparkles
                  overwrite confirm instead — clearing validation is destructive).
                  Regenerate raises the sampling temperature (useCompletion) so
                  the new candidate differs, and overwrites the current draft
                  (last-write-wins; the prior text stays in cell history). */}
              {editable && !isAnonymous && cell.status !== "validated" && visibleTranslated.trim() && (
                <RailButton
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  tooltip={
                    !isCompletionConfigured
                      ? "Set up AI to enable"
                      : !isCompletionAvailable
                        ? "AI service unavailable — try again shortly"
                        : isLoading
                          ? "Generating…"
                          : "Regenerate — another AI variation"
                  }
                  onClick={() => {
                    if (isLoading) return
                    if (!isCompletionConfigured) {
                      onAiSetupNeeded?.()
                      return
                    }
                    if (isCompletionAvailable) {
                      onCompleteSingle(cell, { regenerate: true })
                    }
                  }}
                  disabled={
                    (!isCompletionConfigured && !onAiSetupNeeded) ||
                    !isCompletionAvailable ||
                    isLoading
                  }
                  pulsing={isLoading}
                />
              )}

              {/* FRO-237: Direct mic button on the rail — one-click action
                  without needing to open a popover ("just hit the record
                  mic — quick action"). Round 5: stays visible when a take
                  exists (re-recording is normal; the takes strip manages
                  versions — a vanishing mic read as a bug in QA).
                  WARN fix: the button must NOT be disabled when micDenied —
                  disabled elements receive no mouse events, so the "click for
                  help" affordance is unreachable. Instead keep it enabled and
                  route clicks to the denied-help popover. */}
              {onOpenRecording && editable && (() => {
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

              {/* AQU-513: file-picker upload next to the mic — a plain
                  <input type="file"> so phone browsers can attach an
                  existing wav/mp3/m4a recording without a desktop. Same
                  gating as the mic (editable; visible with a take too). */}
              {editable && (
                <CellAudioUploadButton
                  projectId={project.id}
                  fileId={cell.fileId}
                  cellId={cell.id}
                  username={username}
                  disabled={!editable}
                />
              )}

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

              {/* Round 5: no playOnly — generating here durably attaches the
                  voice; an untranslated line shows the button disabled with
                  the reason instead of hiding it. */}
              <CellTtsButton
                cellId={cell.id}
                text={visibleTranslated}
                original={effectiveSourceText(cell)}
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
              />

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

              {onOpenHistory && (
                <RailButton
                  icon={<HistoryIcon className="h-3.5 w-3.5" />}
                  tooltip="Edit history"
                  onClick={() => onOpenHistory(cell.id)}
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
              label: "Retrieval support",
              renderContent: () => (
                <div className="space-y-1.5 py-3 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">{cell.endorsementCount ?? 0}</span>
                    {" "}endorsement{(cell.endorsementCount ?? 0) === 1 ? "" : "s"} · support{" "}
                    <span className="font-medium text-foreground">{healthValue}%</span>
                  </p>
                  <p>
                    {cellNeedsAttention
                      ? "Lower retrieval support — review terminology and context closely."
                      : "Better retrieval support — human review is still required."}
                  </p>
                </div>
              ),
            },
            {
              value: "backtranslation",
              icon: <FileText className="h-3 w-3" />,
              label: "Back-translation",
              attentionDot: isBtStale ? "amber" : undefined,
              renderContent: () => (
                <div className="flex flex-col gap-2.5">
                  {/* ── Header: a calm label + a quiet explainer. The controls
                      stay subdued so the reading below is the focus, not the
                      buttons. ─────────────────────────────────────────────── */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">Back-translation</span>
                      <AppTooltip content="An AI reading of your translation back in your reference language. Use it to check the meaning carried over — the AI can misread, so treat it as a second opinion, not proof.">
                        <Info className="h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                      </AppTooltip>
                    </div>
                    {/* Controls appear only when there's a reading to act on. */}
                    {cell.backtranslation && !btEditing && (
                      <div className="flex items-center gap-0.5">
                        {/* Regenerate — re-runs the AI on the current translation.
                            Contributor+ only (persisting a BT is a project write). */}
                        {editable && (
                          <AppTooltip content={
                            !isBacktranslationConfigured
                              ? "Sign in or add an AI model in project settings to generate back-translations"
                              : "Regenerate with AI"
                          }>
                            <button
                              type="button"
                              disabled={!isBacktranslationConfigured || isBacktranslating}
                              onClick={() => onBacktranslate?.(cell, "regenerate")}
                              aria-label="Regenerate the back-translation"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
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
                  {visibleTranslated.trim().length === 0 ? (
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
                          {editable && (
                            <button
                              type="button"
                              onClick={() => onBacktranslate?.(cell, "refresh")}
                              disabled={!isBacktranslationConfigured || isBacktranslating || visibleTranslated.trim().length === 0}
                              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 transition-colors hover:bg-amber-500/25 dark:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <RefreshCw className={cn("h-3 w-3", isBacktranslating && "animate-spin")} />
                              Refresh
                            </button>
                          )}
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
                    /* No reading yet — friendly, with one clear primary.
                       Generation is AI-only and on-demand: nothing runs
                       automatically when the translation is committed. */
                    <div className="flex flex-col items-center gap-2.5 rounded-xl bg-muted/40 px-3 py-6 text-center">
                      <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground">
                        See what your translation says when read back, so you can check the meaning carried over.
                      </p>
                      {editable ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onBacktranslate?.(cell, "read-back")}
                            disabled={!isBacktranslationConfigured || isBacktranslating || visibleTranslated.trim().length === 0}
                            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isBacktranslating ? (
                              <><RefreshCw className="h-3 w-3 animate-spin" /> Reading it back…</>
                            ) : (
                              <><Sparkles className="h-3 w-3" /> Read it back with AI</>
                            )}
                          </button>
                          {!isBacktranslationConfigured && (
                            <p className="text-[11px] text-muted-foreground/70">
                              Sign in or add an AI model in project settings to generate one.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground/70">
                          A contributor can generate one with AI.
                        </p>
                      )}
                    </div>
                  )}
                  {/* ── Statistical reference — collapsed by default. A rough
                      corpus-derived gloss kept as a cross-check on the AI
                      reading; local-only, never saved as the cell's BT. ──── */}
                  {visibleTranslated.trim().length > 0 && getStatisticalBt && !btEditing && (
                    <div className="rounded-lg border border-border/60">
                      <button
                        type="button"
                        onClick={() => setBtStatsOpen((v) => !v)}
                        aria-expanded={btStatsOpen}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      >
                        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", btStatsOpen && "rotate-90")} />
                        Statistical gloss
                        <span className="font-normal text-muted-foreground/60">— word-for-word, from this project's own pairs</span>
                      </button>
                      {btStatsOpen && (
                        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                          {statisticalGloss.trim() ? (
                            <p className="text-[13px] leading-relaxed text-foreground/80">{statisticalGloss}</p>
                          ) : (
                            <p className="text-[11px] italic text-muted-foreground">
                              Not enough translated pairs in this project to build a gloss yet.
                            </p>
                          )}
                          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                            Built statistically from this project's translated pairs — no AI involved.
                            It's only as good as the corpus so far: expect rough, literal, sometimes
                            wrong word choices. Use it as a hint, not a reading.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  {/* ── FRO-207: Interlinear alignment panel ──────────────── */}
                  {cell.original.trim() && visibleTranslated.trim() && getAlignmentModel && !btEditing && (
                    <div className="rounded-lg border border-border/60">
                      <button
                        type="button"
                        onClick={() => setBtAlignmentOpen((v) => !v)}
                        aria-expanded={btAlignmentOpen}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      >
                        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", btAlignmentOpen && "rotate-90")} />
                        Alignment
                        <span className="font-normal text-muted-foreground/60">— word-level source/target view</span>
                      </button>
                      {btAlignmentOpen && alignmentModelForExpansion && (
                        <div data-aquilla-alignment-panel className="px-2.5 pb-2.5">
                          <InterlinearAlignmentPanel
                            sourceText={cell.original}
                            targetText={visibleTranslated}
                            alignmentModel={alignmentModelForExpansion}
                            confirmedSeeds={project.alignmentSeeds ?? []}
                            onSeedChange={onAlignmentSeedChange ?? (() => undefined)}
                          />
                        </div>
                      )}
                    </div>
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
              renderContent: () => (
                <FootnoteInline
                  sourceFootnotes={sourceDetailFootnotes}
                  targetFootnotes={allFootnotes.targetFootnotes}
                  editable={editable}
                  isDocx={isDocxFile}
                  onSave={(footnoteIndex, newText) => {
                    const updated = spliceFootnoteText(visibleTranslated ?? "", footnoteIndex, newText)
                    if (updated === null) return false // stale index — keep the editor open (FRO-472)
                    handleEditorCommit({ value: updated, valueHtml: updated })
                  }}
                  onDelete={(footnoteIndex) => {
                    const updated = deleteFootnote(visibleTranslated ?? "", footnoteIndex)
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
              renderContent: () => (
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
                          cellText={visibleTranslated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(visibleTranslated).length === cellAudioTimings.length
                          }
                          editable={editable}
                          onRetranscribe={handleTranscribe}
                          onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                        />
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                        >
                          <Mic className="h-3 w-3" />
                          Re-record
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={handleTranscribe}
                          disabled={!editable || isTranscribing}
                        >
                          <Sparkles
                            className={cn(
                              "h-3 w-3",
                              isTranscribing && "animate-pulse",
                            )}
                          />
                          {isTranscribing ? "Transcribing…" : "Transcribe"}
                        </Button>
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
                          cellText={visibleTranslated}
                          cellId={cell.id}
                          alignedToCellText={
                            tokenizeWords(visibleTranslated).length === generatedVoiceTimings.length
                          }
                          editable={editable}
                          onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">AI generated voice. Drag a voice from the toolbar to regenerate, or:</span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                        >
                          <Mic className="h-3 w-3" />
                          Record over
                        </Button>
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
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                        >
                          <Mic className="h-3 w-3" />
                          Record
                        </Button>
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
              renderContent: () => (
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
            // Metadata — untranslated import columns (DCS TSV supportReference/
            // quote/occurrence/tags, OBS image attachments). Only offered when
            // the cell actually carries a non-empty metadata bucket.
            ...(hasCellMetadata(cell.metadata)
              ? [
                  {
                    value: "metadata",
                    icon: <Braces className="h-3 w-3" />,
                    label: "Metadata",
                    renderContent: () => <CellMetadataTab metadata={cell.metadata as Record<string, unknown>} />,
                  },
                ]
              : []),
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

      {/* FRO-278: confirm before AI Generate overwrites non-empty cell.
          AQU-591: a "Don't ask again" opt-out for non-validated cells. */}
      <GenerateOverwriteDialog
        open={showGenerateConfirm}
        isValidated={cell.status === "validated"}
        onConfirm={(dontAskAgain) => {
          setShowGenerateConfirm(false)
          if (dontAskAgain) setSkipReplaceConfirm(true)
          void completeSingleAndReturn()
        }}
        onCancel={() => setShowGenerateConfirm(false)}
      />

      {/* p1-paragraph-ui-wiring (Task 3): confirm before drafting the whole
          paragraph group as one unit. Always confirms — no per-preference
          opt-out exists for this action (unlike the single-cell Replace
          confirm above). */}
      {onCompleteParagraph && (
        <ParagraphDraftConfirmDialog
          open={showParagraphConfirm}
          totalCount={paragraphGroupSize ?? 0}
          draftableCount={paragraphDraftableCount ?? paragraphGroupSize ?? 0}
          onConfirm={() => {
            setShowParagraphConfirm(false)
            onCompleteParagraph(cell.id)
          }}
          onCancel={() => setShowParagraphConfirm(false)}
        />
      )}

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
// FRO-278 — GenerateOverwriteDialog: extracted to its own module (AQU-646) so
// the media-lens detail pane can reuse it without importing this whole file.
// Re-imported here for the row-level confirm below.
// ---------------------------------------------------------------------------

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { GenerateOverwriteDialog } from "./GenerateOverwriteDialog"

// ---------------------------------------------------------------------------
// p1-paragraph-ui-wiring (Task 3) — ParagraphDraftConfirmDialog
// ---------------------------------------------------------------------------
// Confirm dialog shown before the "Draft paragraph" rail button fans a single
// model call out across every cell in the paragraph group. Unlike
// GenerateOverwriteDialog there is no "don't ask again" opt-out — a bulk,
// multi-cell action always confirms.
//
// Coordinator adjudication: the copy must stay truthful when some of the
// group is already validated (and therefore skipped, per
// completeParagraph's skip-validated-cells guard) — it must never claim a
// count that doesn't match what will actually happen.
// ---------------------------------------------------------------------------

interface ParagraphDraftConfirmDialogProps {
  open: boolean
  /** Full paragraph group size (draftable + already-validated). */
  totalCount: number
  /** Non-validated cell count that will actually be sent to the model. */
  draftableCount: number
  onConfirm: () => void
  onCancel: () => void
}

export function ParagraphDraftConfirmDialog({
  open,
  totalCount,
  draftableCount,
  onConfirm,
  onCancel,
}: ParagraphDraftConfirmDialogProps) {
  const description = draftableCount === totalCount
    ? `Draft this paragraph? ${totalCount} cells will be drafted as one unit.`
    : `Draft this paragraph? ${draftableCount} of ${totalCount} cells will be drafted; already-validated cells are kept as-is.`

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="paragraph-draft-title" aria-describedby="paragraph-draft-desc">
        <DialogHeader>
          <DialogTitle id="paragraph-draft-title">Draft this paragraph?</DialogTitle>
          <DialogDescription id="paragraph-draft-desc">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>
            Draft paragraph
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
