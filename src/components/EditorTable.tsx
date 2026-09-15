import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from "react"
import { createPortal } from "react-dom"
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type OnViewableItemsChangedInfo,
} from "@legendapp/list/react"
import {
  Check, AlertTriangle, AlertCircle,
  MessageCircle, Play, Pause, Mic, MicOff, FileText,
  ArrowRight, Activity, NotebookPen, Pencil, ChevronDown, Music, Braces,
  Languages,
  Lock,
  Pilcrow,
  PilcrowRight,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
  Bold,
  VolumeX,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { LaneCombobox } from "@/components/LaneCombobox"
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
import type { TranslationRule, RuleInfraction, ProjectRecord, Voice, ProjectTtsSettings, OrderedBy, FileType } from "@/lib/parsers/types"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { formatInfractionReason } from "@/lib/rules/format-infraction"
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
import { needsAttentionFromConfidence, resolveDecayConfig } from "@/lib/health/decay-engine"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { StaleSourceIndicator } from "./StaleSourceIndicator"
import { HealthRibbon } from "./HealthRibbon"
import { type HealthRibbonPoint } from "@/lib/health/health-ribbon"
import { ribbonInputCacheFor, type RibbonInputCache } from "@/lib/health/ribbon-inputs"
import { useHealthCalculationsEnabled } from "@/lib/health/kill-switch"
import { TranslatedEditor, type FootnoteInsertionAnchor, type TranslatedEditorHandle } from "./TranslatedEditor"
import { TimelineAddMedia } from "./TimelineAddMedia"
import { CellTtsButton } from "./CellTtsButton"
import { BacktranslationPanel } from "./BacktranslationPanel"
import {
  overlayBacktranslation,
  type BacktranslationActionSource,
  type BacktranslationRecord,
} from "@/lib/completion/bt-record"
import { ContextualDraftCard } from "./contextual/ContextualDraftCard"
import { CellActionRail, RailButton, isInteractiveTarget } from "./CellActionRail"
import { useIsMediaCursorCell, useMediaSyncActive } from "@/lib/timeline/media-cursor"
import { useUiSlot } from "@/lib/ui-slots"
import { CastGutterVoice } from "@/components/voice/CastGutterVoice"
import { projectTargetLaneLanguages, showVoiceLanguageBadge } from "@/lib/audio/inworld-voices"
import { useIsQueueCurrentCell, useQueueCurrentCellId } from "@/lib/audio/play-queue"
import { useVideoClockPlaying, useVideoSoundingCellId } from "@/lib/timeline/video-clock"
import { useRailIdleHide } from "@/hooks/useRailIdleHide"
import {
  computeRailPinned,
  isRailFocusPinned,
  railFocusOwnerOnBlur,
  railFocusOwnerOnFocus,
} from "@/lib/editor/cell-rail-pin"
import { shouldDismissCellErrorsOnBlur } from "@/lib/editor/cell-error-dismiss"
import { CellExpansion } from "./CellExpansion"
import { CellMetadataTab, hasCellMetadata } from "./CellMetadataTab"
import { tokenizeWords, activeWordRange } from "@/lib/audio/timings"
import { KaraokeReadText } from "./KaraokeReadText"
import { resolveCurrentCellIndex } from "@/lib/editor/current-index"
import { useCellAudio } from "@/hooks/useCellAudio"
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
import { Popover, PopoverContent, PopoverDescription, PopoverTitle } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"
import { CellPresenceBadges } from "./CellPresenceBadges"
import { isLaneArchived } from "@/components/project-lane-archive"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { InlineAiError } from "./InlineAiError"
import { CellNumberPill } from "./cell/CellNumberPill"
import {
  EditorTargetCellColumn,
  EditorTargetCellWell,
  EditorTargetReadSurface,
} from "./cell/EditorCellSurface"
import {
  SanitizedRichHtml,
  TargetIdmlHtml,
  TargetRichHtml,
  UsfmNoteChip,
} from "./cell/EditorCellContent"
import { TargetDraftActions, TargetReferenceActions } from "./cell/TargetCellActions"
import { TargetValidationControl } from "./cell/TargetValidationControl"
import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"
import { cellIdsForMilestonePage } from "@/lib/milestone-navigation"
import { getMilestoneSplit, useMilestoneSplit } from "@/lib/store/milestone-split-pref"
import { EDITOR_SURFACE_TOOLBAR_CLASS } from "./editor-surface-toolbar"
import { CellVoicePanel } from "./cell/CellVoicePanel"
// CellAudioRecordButton: getUnsupportedReason used by the rail mic denied-help
// popover (FRO-237). The component itself is no longer in the overflow popover.
import { getUnsupportedReason } from "./CellAudioRecordButton"
// AQU-513: plain file-picker upload next to the mic — works on mobile too.
import { CellAudioUploadButton } from "./CellAudioUploadButton"
import { resolveTargetAudio } from "@/lib/audio/track-audio"
import { CellTakeBlock } from "./CellTakeBlock"
import { fmtClock } from "./timeline/format"
import type { LinkedTake } from "@/lib/audio/linked-takes"
import { useMicPermission } from "@/hooks/useMicPermission"
import { assignedCastVoiceId, findVoice, getVoiceLibrary, resolveCastVoice } from "@/lib/audio/voices"
import { useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import {
  cellNumberLabel,
  importDisplayLabel,
  verseLabelFromCanonical,
} from "@/lib/scripture-reference"
import {
  firstActuallyVisibleIndex,
  resolveActiveChapterLabel,
} from "@/lib/chapter-navigation"
import { isPerfLogEnabled } from "@/lib/perf-log"
import {
  type DirectionMode,
  type TextDirection,
  resolveTextDirection,
} from "@/lib/text-direction"
import { partitionInfractions } from "@/lib/rules/waivers"
import { selectTermRules, computeLiveTermInfractions, mergeBlotInfractions } from "@/lib/rules/live-term-check"
import { ViolationToast } from "./ViolationToast"
import { VOICE_ASSIGN_MIME } from "./VoiceLibraryPanel"
import type { RangeHighlight } from "./HighlightedText"
import { TermLookupPopover } from "./TermLookupPopover"
import type { Concept, ConceptDraft } from "@/lib/terminology/types"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFileFontSizes } from "@/lib/store/file-view-prefs"
import { useEditorActions } from "@/context/EditorActionsContext"
import { isInMemberScope } from "@/lib/sync/member-scopes"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import { buildSourceChip, type ContextChip } from "@/lib/agent/context-chip"
import { ownCastName } from "@/lib/timeline/cue-character"
import { parseTimestampRange } from "@/lib/video/vtt-generator"
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
import { displayedSourceText, effectiveSourceText, projectedSourceValue, sourceCommitFields, sourceEditorSeed } from "@/lib/cell-text"
import { deleteFootnote, spliceFootnoteText } from "@/lib/footnotes/splice"
import type { FootnoteViewMode, VisibleFootnoteEntry } from "@/lib/footnotes/types"
import type { TargetKeyTermHighlightMode } from "@/hooks/useTargetKeyTermHighlightPreference"
import { hasMeaningfulRichText } from "@/lib/richtext/editor-content"
import {
  resolveIdmlEditorConfiguration,
  validateIdmlEditorCommit,
} from "@/lib/richtext/idml-editor"
import {
  idmlPointerSelectionFromPoint,
  type IdmlPointerSelection,
} from "@/lib/richtext/idml-caret"
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

/** The gutter track widens by the character circle's w-6 when the cast
 *  gutter is on (stacked media lens). One shared type keeps the header row,
 *  paragraph bar, and rows in the same template.
 *
 *  AQU-1101: the text tracks are `minmax(0,1fr)`, never a bare `1fr`. A bare
 *  `1fr` carries an implicit `min-width: auto`, so a single unbreakable token
 *  (a URL, a long identifier) widens ITS track to min-content and steals the
 *  width from the sibling — source and target stop lining up with each other
 *  and with the header row. Flooring the minimum at 0 makes the two tracks
 *  equal fractions of the row whatever the content is; the cell surfaces then
 *  break the token with `break-words` (see EditorCellSurface). */
type EditorGridCols =
  | "grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"
  | "grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
const LEGEND_LIST_DRAW_DISTANCE_PX = 240

/**
 * 2026-08-07 (wire c): vertical follow for the stacked media lens — the table
 * tracks the cell the queue is RUNNING, with the timeline's scroll-truce
 * mirrored at row granularity. Mounted only while the timeline is stacked
 * (media-sync active) and renders nothing, so the table root never subscribes
 * to queue state and playback ticks cost zero table re-renders.
 */
export function MediaFollowDriver({
  isCellDisplayed,
  scrollToCell,
  userScrollListenerRef,
  programmaticStampRef,
  followCommand,
  onFollowRest,
}: {
  isCellDisplayed: (cellId: string) => boolean
  scrollToCell: (cellId: string) => void
  userScrollListenerRef: React.MutableRefObject<((opts?: { force?: boolean }) => void) | null>
  programmaticStampRef: React.MutableRefObject<number>
  /** Explicit intent from user gestures: chip/row clicks ENGAGE, inspection
   *  jumps RELEASE. seq-keyed so repeats of the same intent still apply. */
  followCommand: { seq: number; intent: "engage" | "release" } | null
  /** Fired when the queue stops running (and on unmount) — the table lifts
   *  its follow-hover lock. */
  onFollowRest: () => void
}) {
  // AQU-646 round 5: EITHER transport. This subscribed to the queue alone,
  // which is why the dialogue table never scrolled on a file whose transport is
  // the linked picture — the queue is idle there by construction, so the scroll
  // effect below could never pass its guard. The queue still wins when it is
  // genuinely running, matching the video pane's caption precedence.
  const queueCellId = useQueueCurrentCellId()
  const videoCellId = useVideoSoundingCellId()
  const videoPlaying = useVideoClockPlaying()
  const runningCellId = queueCellId ?? (videoPlaying ? videoCellId : null)
  // Same stale-singleton guard as the timeline: a transport running another
  // file's cells must not scroll this table.
  const queueRunning = runningCellId != null && isCellDisplayed(runningCellId)
  const [follow, setFollow] = useState(true)
  // Rising edge of running (play, resume) re-engages following — a user who
  // scrolled away re-opts-in by pressing play, exactly like the track view.
  // The falling edge (pause/stop) lets the table lift its hover lock so a
  // parked cursor gets normal hover back without needing to move.
  useEffect(() => {
    if (queueRunning) setFollow(true)
    else onFollowRest()
  }, [queueRunning, onFollowRest])
  useEffect(() => () => onFollowRest(), [onFollowRest])
  // Explicit intents win over the truce in both directions. The ref seeds
  // from the CURRENT command so anything issued while this driver was
  // unmounted (text-lens jumps default to "release") is dead on arrival —
  // replaying it here silently killed following after a lens round-trip.
  const appliedCommandSeqRef = useRef(followCommand?.seq ?? 0)
  useEffect(() => {
    if (!followCommand || followCommand.seq === appliedCommandSeqRef.current) return
    appliedCommandSeqRef.current = followCommand.seq
    setFollow(followCommand.intent === "engage")
  }, [followCommand])
  // A cell boundary IS the page-flip: bring the running row to ~1/3 height.
  useEffect(() => {
    if (follow && queueRunning && runningCellId != null) scrollToCell(runningCellId)
  }, [follow, queueRunning, runningCellId, scrollToCell])
  // The truce: a scroll more than 250ms after our own programmatic scroll is
  // the USER moving away — stop following until the next play/resume. 250ms
  // (vs the track's 150ms) absorbs LegendList's post-scrollToIndex settling
  // corrections under recycled, estimated-height rows.
  const runningRef = useRef(queueRunning)
  runningRef.current = queueRunning
  useEffect(() => {
    userScrollListenerRef.current = (opts) => {
      if (!runningRef.current) return
      // force: a WHEEL is unambiguously the user — it must escape follow even
      // while one of our smooth glides is streaming (self-re-stamping) scroll
      // events; without it, dense boundaries could chain glides into a wall.
      if (opts?.force || performance.now() - programmaticStampRef.current > 250) {
        setFollow(false)
      }
    }
    return () => {
      userScrollListenerRef.current = null
    }
  }, [userScrollListenerRef, programmaticStampRef])
  return null
}
const EMPTY_CONCEPTS: Concept[] = []

interface EditorActivationOptions {
  /**
   * AQU-618: async flows may restore the editor that launched them only when
   * the user has not activated another cell in the meantime.
   */
  ifActivationVersion?: number
}

type ActivateEditor = (cellId: string, options?: EditorActivationOptions) => void

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

export function applyRowOverlays(
  cell: CellData,
  options: {
    audioEntry?: CellAudioEntry
    backtranslation?: BacktranslationRecord
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
        // AQU-782: forward the trim window so the text-section Transcribe
        // control windows an imported clip to just this section (mirrors
        // mergeCellsWithAudio). Without it, transcribeCell saw no trim and
        // fell through to whole-clip transcription for every section.
        ...(attachment.trimStartMs != null ? { trimStartMs: attachment.trimStartMs } : {}),
        ...(attachment.trimEndMs != null ? { trimEndMs: attachment.trimEndMs } : {}),
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

  return overlayBacktranslation(next, options.backtranslation, options.projectId)
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
 *  click-to-expand: full message + actions (engine-specific recovery, dismiss).
 *
 * A1: error popover body is surfaced from the first click on the badge (not
 *     just via a tooltip) and includes a plain-English recovery hint.
 * A4: dismissing the popover keeps a muted "Not voiced" badge rather than
 *     clearing the failed state entirely — cell still looks unvoiced.
 */
/** Icon shell for gutter synth status — stays inside the fixed w-5 badge column. */
const gutterIconShell =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"

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
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  // A2: "Open audio setup" must DO something. When the callback is provided we
  // call it (host may already be in audio mode); otherwise we navigate directly
  // to the project settings page which contains the Gemini API key section.
  // AQU-522: deep-link with `?q=gemini` so the settings search filters to the
  // Voice card and the key entry is visible immediately (no scrolling/hunting).
  const openVoiceSetup = () =>
    onOpenAudioSetup ? onOpenAudioSetup() : navigate(`/project/${projectId}/settings?q=gemini`, {
      state: { backgroundLocation: location, projectSettingsModalDepth: 1 },
    })
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
      ? t("editor.tts.translatingBeforeVoicing")
      : pct != null
        ? t("editor.tts.loadingVoiceModelPct", { percent: pct })
        : t("editor.tts.loadingVoiceModel")
    return (
      <AppTooltip content={tooltip}>
        <span
          role="img"
          aria-label={tooltip}
          data-testid="synth-status-busy"
          className={cn(gutterIconShell, "bg-primary/15 text-primary")}
        >
          <Spinner className="h-3 w-3" />
        </span>
      </AppTooltip>
    )
  }
  if (status.kind === "synthesizing") {
    return (
      <AppTooltip content={t("editor.tts.generatingAudio")}>
        <span
          role="img"
          aria-label={t("editor.tts.generatingAudio")}
          data-testid="synth-status-busy"
          className={cn(gutterIconShell, "bg-primary/15 text-primary")}
        >
          <Spinner className="h-3 w-3" />
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
        label: t("editor.tts.openAudioSetup"),
        primary: true,
        onClick: openVoiceSetup,
      })
    } else if (
      error.category === "translation-not-configured" ||
      error.category === "no-source-text" ||
      error.category === "git-project-unsupported" ||
      error.category === "sign-in-required" ||
      error.category === "hosted-tts-not-configured" ||
      error.category === "hosted-tts-failed" ||
      error.category === "seed-vc-not-configured" ||
      error.category === "seed-vc-failed" ||
      error.category === "gemini-failed"
    ) {
      // Soft fixes — the popover body explains what to do; no inline action.
    } else {
      actions.push({
        label: t("editor.tts.openAudioSetup"),
        onClick: openVoiceSetup,
      })
    }

    // A4: dismissed — muted badge, no popover. Still communicates "not voiced".
    if (dismissed) {
      return (
        <AppTooltip content={t("editor.tts.failedTooltip")}>
          <span
            role="img"
            aria-label={t("editor.tts.notVoiced")}
            data-testid="synth-status-dismissed"
            className={cn(gutterIconShell, "bg-muted/60 text-muted-foreground")}
          >
            <MicOff className="h-3 w-3" />
          </span>
        </AppTooltip>
      )
    }

    // Icon-only trigger so the chip fits the w-5 gutter; full detail lives in the popover.
    return (
      <CellAiStatusPopover
        error={error}
        actions={actions}
        onDismiss={handleDismiss}
        trigger={
          <button
            type="button"
            aria-label={t("editor.tts.audioFailed")}
            data-testid="synth-status-error"
            className={cn(
              gutterIconShell,
              "bg-destructive/15 text-destructive hover:bg-destructive/25",
            )}
          >
            <VolumeX className="h-3 w-3" />
          </button>
        }
      />
    )
  }
  return null
}

// Stable empty sentinels so per-cell "map.get(id) ?? []" derivations keep a
// steady reference when the cell has no entry — otherwise every render would
// mint a fresh [] and break React.memo for every row.
const EMPTY_EXAMPLES: ScoredPair[] = []
// Kill switch (lib/health/kill-switch.ts): with health off, every row shares
// this one point so row memoization holds and no ribbon is rendered.
const EMPTY_RIBBON: Map<string, HealthRibbonPoint> = new Map()
const HEALTH_DISABLED_POINT: HealthRibbonPoint = { id: "health-disabled", stage: "untranslated", evidenceWeight: 1 }
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
/** AQU-1154: how long a departed peer's last draft stays over a row whose own
 *  text has not caught up yet. Bounds the overlay if their commit never lands. */
export const REMOTE_DRAFT_HOLD_MS = 15_000

export type { BacktranslationActionSource }

export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  /** AQU-646: scroll to a cell by id in DISPLAY space (lens-sorted — correct
   *  for time-ordered files, where store order ≠ display order), optionally
   *  flashing it. Returns false when the id is not currently displayable. */
  scrollToCellId: (cellId: string, opts?: { flash?: boolean; follow?: "engage" | "release" }) => boolean
  /** 2026-08-08: command the media-lens playback follow directly (wire b —
   *  a row click doesn't scroll the table but must re-engage following). */
  setMediaFollow: (intent: "engage" | "release") => void
  focusCellEditorIndex: (index: number) => void
  getCurrentIndex?: () => number
  /** Briefly outline a cell after a "Go to cell" so the user sees where the search landed. */
  flashCell: (cellId: string, searchTerm: string) => void
  /** AQU-646 round 8: pulse rows twice WITHOUT selecting them — "look here",
   *  for the lines bracketing a silence the user clicked on the source band. */
  pulseCells: (cellIds: readonly string[]) => void
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
  fileType?: FileType
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
  /** 2026-08-07: the character gutter — a voice circle per speaking row,
   *  aligned to the source's first line. On ONLY in the stacked media lens
   *  (Sam's call: not the Text lens, not the voice-panel table). */
  castGutter?: boolean
  /** LIVE cast state for the gutter (useProjectTts's copy — cast assignments
   *  update through tts.settings, NOT the project settings-overlay snapshot,
   *  same rule the old detail pane followed). Stable ref between saves. */
  ttsSettings?: ProjectTtsSettings
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
  /** Fires with the row that owns keyboard/pointer focus (any surface in it),
   *  or null when focus leaves the table. Non-lock-bearing presence: peers see
   *  this user on the row even when they never activate the editor. */
  onViewCell?: (cellId: string | null) => void
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
  /** AQU-913: forget this cell's inline AI failures — the draft error, the
   *  back-translation error, and the per-cell "error" status behind them.
   *  Called when focus leaves the cell's row so a failure stops following the
   *  user around the file. Omit to keep errors sticky (legacy callers). */
  onClearCellErrors?: (cellId: string) => void
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<boolean>
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
  backtranslationByCellId?: ReadonlyMap<string, BacktranslationRecord>
  /**
   * A row's takes that live on ANOTHER cell (review feedback, 2026-08-22):
   * subtitle cell id → the audio cues performing it that hold a recording, in
   * film order, already merged with the cue sibling's attachments.
   *
   * This table reads exactly one file (`cellStore.getFileId()`), which is why
   * the Recording tab used to show "No audio yet" over a line whose take was
   * plainly on the timeline. Absent/empty ⇒ every non-dubbing arrangement
   * behaves exactly as before.
   */
  linkedTakesByCell?: ReadonlyMap<string, LinkedTake[]>
  /** Called when user saves a BT edit. Parent emits `cell.backtranslation.set`. */
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  /** On-demand statistical gloss (corpus-derived, never persisted) for the BT
   *  tab's collapsed reference section. */
  getStatisticalBt?: (translatedText: string) => string
  cellOpenCommentCount?: Map<string, number>
  // onOpenComments/onOpenHistory moved to EditorActionsContext (FRO perf
  // cleanup) — pure pass-through, never consumed above the row.
  onSeekToCue?: (cellId: string) => void
  /**
   * AQU-646 round 8: add and remove lines from the TABLE, mirroring the
   * gestures the timeline already offers. Undefined in every arrangement but
   * VTT-plus-footage — and then nothing here renders at all, which is how every
   * other workflow stays untouched.
   *
   * The silences arrive pre-resolved (one pass per store version in the
   * workspace) so a thousand-row file does one map lookup per row rather than
   * a scan. A row with no room after it simply gets no control — the same rule
   * as the timeline's pencil, never a disabled button.
   */
  sourceLineEditing?: {
    /** The silence before the first cue, offered as "insert above" on row 0. */
    head: { startSec: number; endSec: number } | null
    /** Keyed by the cell whose row offers "insert below". */
    afterCell: ReadonlyMap<string, { startSec: number; endSec: number }>
    onAddLine(startSec: number, endSec: number): void
    /** The workspace owns what is removable, exactly as the timeline lane does. */
    canRemove(cell: CellData): boolean
    onRemoveLine(cellId: string): void
  }
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
  /** Add-from-selection: create a terminology entry from selected source text. */
  onAddConceptFromSelection?: (draft: ConceptDraft) => void | Promise<void>
  /** Non-null when the user cannot write terminology (below Maintainer) —
   *  the add-term popover opens blocked with this reason instead of accepting input. */
  addConceptBlockedReason?: string | null
  /** May this user APPROVE a term (enforce it), vs only suggest one? */
  canApproveConcept?: boolean
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
   *  History tab to query the Postgres event log on demand. */
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
  /** Emits the exact virtualized viewport so translate-as-read can remain
   *  bounded to rows the user can currently see. */
  onVisibleCellIdsChange?: (cellIds: string[]) => void
  /**
   * FRO-317: when true, USFM \f...\f* footnotes render as a distinct panel
   * immediately below each cell row. Editing is safe only for USFM files.
   */
  showFootnotesInline?: boolean
  /** True when a full footnote surface is active, so source chips stay markers only. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** When approved target renderings receive the subtle key-term highlight. */
  targetKeyTermHighlightMode?: TargetKeyTermHighlightMode
  /** Emits USFM footnotes from the currently visible virtual rows. */
  onVisibleFootnotesChange?: (entries: VisibleFootnoteEntry[]) => void
  /** Called after a target footnote is created so the parent can reveal footnotes. */
  onFootnoteCreated?: () => void
  /** Optional controls on the right of the chapter navigation row. */
  chapterNavTrailing?: React.ReactNode
}

export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  project, cellStore, fileType, username, activeLane = "", lanes, archivedLanes, onLaneChange, defaultLaneLabel,
  onEditTargetLanguage,
  isCompletionConfigured, isCompletionAvailable,
  completing, examples, errors, previews, onClearCellErrors,
  onCompleteSingle, onCompleteBatch, onCompleteParagraph, healthMap,
  infractions = new Map(), rules = [],
  isBacktranslationConfigured, onBacktranslate, backtranslating, backtranslationErrors,
  backtranslationByCellId,
  linkedTakesByCell,
  onSaveBacktranslation, getStatisticalBt,
  cellOpenCommentCount,
  onSeekToCue,
  sourceLineEditing,
  lineNumbersEnabled, cellLabelsEnabled, sourceDirectionMode = "auto", targetDirectionMode = "auto", sourceTextDirection, targetTextDirection,
  isAnonymous, onJumpToCell,
  audioLens, castGutter = false, ttsSettings, onOpenAudioSetup,
  onAttachMediaFile, onAttachMediaUrl,
  orderedBy,
  onProjectChanged, onAddConceptFromSelection, addConceptBlockedReason, canApproveConcept, onAskAiFromSelection, onAssignVoice,
  onCellCommitted,
  getPendingTargetEventId,
  onOptimisticEdit,
  cellLockHolders,
  presenceStore,
  cellsWithRemoteChange,
  onClaimCell, onReleaseCell, onViewCell, onTargetPresenceSelection, onAckRemoteChange,
  staleCellIds,
  upstreamStaleCellIds,
  getTokenForFile,
  getAlignmentModel,
  onAlignmentSeedChange,
  showFootnotesInline,
  footnotePanelActive,
  footnoteViewMode = "off",
  targetKeyTermHighlightMode = "never",
  onVisibleRefChange,
  onVisibleCellIdsChange,
  onVisibleFootnotesChange,
  onFootnoteCreated,
  chapterNavTrailing,
}, ref) {
  const t = useT()
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
    subsectionKey?: string
  } | null>(null)
  const clearChapterNavigationSelection = useCallback(() => {
    if (getMilestoneSplit()) return
    setChapterNavigationSelection(null)
  }, [])
  const [activeEditorCellId, setActiveEditorCellId] = useState<string | null>(null)
  // AQU-618: state alone cannot distinguish a late async focus restoration
  // from a newer user click because the completion and click may settle in
  // the same React batch. Keep a synchronous identity + version alongside it.
  const activeEditorCellIdRef = useRef<string | null>(null)
  const editorActivationVersionRef = useRef(0)
  // AQU-669: the single, exclusive cell whose action rail is focus-pinned. At
  // most one cell is ever the "focused cell", so the rail pin is derived from
  // `focusedRailCellId === cell.id` rather than each row's own local
  // focus-within flag. When focus moves to another cell the new focus-in
  // overwrites this id, which structurally un-pins the previous row even if its
  // focus-out never fired (across TipTap/ProseMirror surfaces or re-rendered
  // rows) — so stale rails can no longer accumulate. See cell-rail-pin.ts.
  const [focusedRailCellId, setFocusedRailCellId] = useState<string | null>(null)
  const handleRowFocusPin = useCallback((cellId: string) => {
    setFocusedRailCellId((cur) => railFocusOwnerOnFocus(cur, cellId))
  }, [])
  const handleRowFocusRelease = useCallback((cellId: string) => {
    // Only clear when this row is still the recorded owner: a newer focus has
    // already overwritten the id, and an out-of-order focus-out from the row we
    // just left must not wipe it.
    setFocusedRailCellId((cur) => railFocusOwnerOnBlur(cur, cellId))
  }, [])
  // The focus-pinned row IS "where this user is" — publish it as presence so
  // colleagues see the row even before (or without) an editor activation.
  useEffect(() => {
    onViewCell?.(focusedRailCellId)
  }, [focusedRailCellId, onViewCell])
  useEffect(() => {
    const handleDocumentFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof Node && listRootRef.current?.contains(target)) return

      // AQU-669: row-level blur is not a sufficient release signal across
      // TipTap surfaces and recycled virtual rows. Whenever browser focus
      // demonstrably enters a surface outside the cell list, release the
      // exclusive rail owner so an abandoned row cannot stay pinned.
      setFocusedRailCellId(null)
    }

    document.addEventListener("focusin", handleDocumentFocusIn)
    return () => document.removeEventListener("focusin", handleDocumentFocusIn)
  }, [])
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
  const fileCellIds = useCellIds(cellStore, orderedBy, !!audioLens)
  const cellStoreVersion = useCellStoreVersion(cellStore)
  const audioFileId = cellStore.getFileId()
  const splitByMilestone = useMilestoneSplit()
  const pendingJumpCellIdRef = useRef<string | null>(null)
  const milestoneNavigation = useMemo(() =>
    readAtVersion(cellStoreVersion, () => cellStore.getNavigationIndex(fileCellIds)),
  [cellStore, cellStoreVersion, fileCellIds])
  const milestoneKeyByCellId = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of milestoneNavigation) {
      for (const cellId of entry.cellIds) map.set(cellId, entry.key)
    }
    return map
  }, [milestoneNavigation])
  const idmlMilestoneNavigation = useMemo(() =>
    fileType === "idml" || readAtVersion(cellStoreVersion, () => milestoneNavigation.some((entry) => {
      const view = cellStore.getCellView(entry.firstCellId)
      return Boolean(view && resolveIdmlEditorConfiguration(view.metadata, view.originalHtml))
    })),
  [cellStore, cellStoreVersion, fileType, milestoneNavigation])
  const subsectionKeyByCellId = useMemo(() => {
    const map = new Map<string, string>()
    if (!idmlMilestoneNavigation) return map
    for (const entry of milestoneNavigation) {
      for (const subsection of entry.subsections) {
        for (const cellId of subsection.cellIds) map.set(cellId, subsection.key)
      }
    }
    return map
  }, [idmlMilestoneNavigation, milestoneNavigation])
  const displayCellIds = useMemo(() => {
    if (!splitByMilestone) return fileCellIds
    const selected = chapterNavigationSelection?.fileId === audioFileId
      ? chapterNavigationSelection
      : null
    const key = selected?.label && milestoneNavigation.some((entry) => entry.key === selected.label)
      ? selected.label
      : milestoneNavigation[0]?.key
    if (!key) return fileCellIds
    // The 50-cell ranges are picker jump targets, not extra pages: a 74-cell
    // section stays one page when this toggle is on.
    return cellIdsForMilestonePage(milestoneNavigation, key) ?? fileCellIds
  }, [
    audioFileId,
    chapterNavigationSelection,
    fileCellIds,
    milestoneNavigation,
    splitByMilestone,
  ])
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

  // 2026-08-07 (wire c): follow-driver plumbing. The driver itself mounts
  // only while the timeline is stacked above (media-sync active).
  const mediaSyncActive = useMediaSyncActive()
  const followProgrammaticStampRef = useRef(0)
  const followUserScrollListenerRef = useRef<((opts?: { force?: boolean }) => void) | null>(null)
  const followIsCellDisplayed = useCallback(
    (cellId: string) => displayCellIdsRef.current.includes(cellId),
    [],
  )
  // 2026-08-08: explicit follow intents. A chip/row click is "watch this" —
  // it ENGAGES following even if the user had scrolled away; inspection jumps
  // (search, presence, the segment navigator) RELEASE it deliberately instead
  // of depending on racy stamp timing. Commands ride table state (rare, one
  // per user gesture) into the driver.
  const [followCommand, setFollowCommand] = useState<{ seq: number; intent: "engage" | "release" } | null>(null)
  const followCommandSeqRef = useRef(0)
  const issueFollowCommand = useCallback((intent: "engage" | "release") => {
    followCommandSeqRef.current += 1
    setFollowCommand({ seq: followCommandSeqRef.current, intent })
  }, [])
  /** >0 while a code-driven scroll (possibly a native SMOOTH animation that
   *  emits events for hundreds of ms) is in flight — handleListScroll
   *  re-stamps the truce for every event that arrives inside the window. */
  const programmaticInFlightRef = useRef(0)
  /** EVERY code-driven list scroll goes through here. Stamping only inside
   *  one caller left the rest (navigator picks, focus scrolls, jumps) reading
   *  as user scrolls — which silently killed following (2026-08-08 forensics). */
  const programmaticListScroll = useCallback(
    (index: number, opts: { viewPosition: number; animated: boolean; follow?: "engage" | "release" }) => {
      followProgrammaticStampRef.current = performance.now()
      if (opts.follow) issueFollowCommand(opts.follow)
      programmaticInFlightRef.current += 1
      const done = listRef.current?.scrollToIndex({
        index,
        viewPosition: opts.viewPosition,
        animated: opts.animated,
      })
      // The promise resolves on scrollend (80ms-idle fallback where scrollend
      // is missing); +150ms grace absorbs LegendList's settling corrections
      // under recycled, estimated-height rows.
      void Promise.resolve(done)
        .catch(() => {})
        .then(() => {
          window.setTimeout(() => {
            programmaticInFlightRef.current = Math.max(0, programmaticInFlightRef.current - 1)
          }, 150)
        })
    },
    [issueFollowCommand],
  )
  // 2026-08-08 hover quarantine: Chromium re-evaluates :hover AND re-fires
  // mouseenter after every programmatic scroll, so during playback-follow the
  // row shade and action rail "drift" onto whatever slides under a PARKED
  // cursor. Each follow step arms a lock attribute on the list root; the row
  // styles and mouseenter handler stand down under it. Any GENUINE pointer
  // gesture — movement with an actual coordinate delta, a wheel tick, a press
  // — lifts it instantly (the browser's synthetic re-fires keep identical
  // coordinates, so they never unlock). Attribute-only: no React state, no
  // row re-renders, hover feels native the moment the mouse is really used.
  const setFollowHoverLock = useCallback((locked: boolean) => {
    const el = listRootRef.current
    if (!el) return
    if (locked) el.setAttribute("data-follow-hover-lock", "")
    else el.removeAttribute("data-follow-hover-lock")
  }, [])
  // Re-runs when the list root first renders (it is conditional on having
  // rows) — binding once on mount left the listeners unattached for the whole
  // session when the table mounted empty, making the lock un-liftable.
  const hasListRows = displayCellIds.length > 0
  useEffect(() => {
    const el = listRootRef.current
    if (!el) return
    let last: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent) => {
      const moved = last != null && Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 1
      last = { x: e.clientX, y: e.clientY }
      if (moved) setFollowHoverLock(false)
    }
    const unlock = () => setFollowHoverLock(false)
    const onWheel = () => {
      setFollowHoverLock(false)
      // Wheel is the one gesture the scroll-event truce can't attribute while
      // our own glide is streaming events — force the disengage directly.
      followUserScrollListenerRef.current?.({ force: true })
    }
    el.addEventListener("pointermove", onMove, { capture: true, passive: true })
    el.addEventListener("wheel", onWheel, { capture: true, passive: true })
    el.addEventListener("pointerdown", unlock, { capture: true, passive: true })
    return () => {
      el.removeEventListener("pointermove", onMove, { capture: true } as EventListenerOptions)
      el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions)
      el.removeEventListener("pointerdown", unlock, { capture: true } as EventListenerOptions)
    }
  }, [setFollowHoverLock, hasListRows])
  const handleFollowRest = useCallback(() => setFollowHoverLock(false), [setFollowHoverLock])
  const revealCellPage = useCallback((cellId: string): boolean => {
    if (displayCellIdsRef.current.includes(cellId)) return true
    if (!splitByMilestone) return false
    const key = milestoneKeyByCellId.get(cellId)
    if (!key) return false
    const subsectionKey = idmlMilestoneNavigation
      ? subsectionKeyByCellId.get(cellId)
      : undefined
    setChapterNavigationSelection({
      fileId: audioFileId,
      label: key,
      ...(subsectionKey ? { subsectionKey } : {}),
    })
    pendingJumpCellIdRef.current = cellId
    return true
  }, [
    audioFileId,
    idmlMilestoneNavigation,
    milestoneKeyByCellId,
    splitByMilestone,
    subsectionKeyByCellId,
  ])
  const followScrollToCell = useCallback((cellId: string) => {
    const index = displayCellIdsRef.current.indexOf(cellId)
    if (index < 0) {
      if (revealCellPage(cellId)) setFollowHoverLock(true)
      return
    }
    setFollowHoverLock(true)
    // A range picked in the segment navigator must not stay latched while
    // playback walks past it — drop it so the trigger quietly tracks the
    // sounding cell (Sam 2026-08-07), same as scrollToCellId does for jumps.
    clearChapterNavigationSelection()
    // 0.35: the running row rides high enough to leave reading room below.
    // Animated (Sam 2026-08-08): the follow glides instead of teleporting.
    programmaticListScroll(index, { viewPosition: 0.35, animated: true })
  }, [clearChapterNavigationSelection, programmaticListScroll, revealCellPage, setFollowHoverLock])

  // Durable cell audio (AD-2 cell.audio.* grammar). Per-file read; overlay each
  // visible row's attachments + selected clips at render time, rather than
  // cloning the entire active file into audio-enriched CellData objects.
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

  useEffect(() => {
    if (!activeEditorCellId) return
    if (displayCellIds.includes(activeEditorCellId)) return
    if (activeEditorCellIdRef.current === activeEditorCellId) {
      activeEditorCellIdRef.current = null
    }
    setActiveEditorCellId(null)
  }, [activeEditorCellId, displayCellIds])

  // AQU-669: drop the focus pin if its cell scrolls out of the list / lane —
  // a pin can't belong to a row that no longer renders.
  useEffect(() => {
    if (!focusedRailCellId) return
    if (displayCellIds.includes(focusedRailCellId)) return
    setFocusedRailCellId(null)
  }, [focusedRailCellId, displayCellIds])

  const handleActivateEditor = useCallback<ActivateEditor>((cellId, options) => {
    if (
      options?.ifActivationVersion !== undefined
      && options.ifActivationVersion !== editorActivationVersionRef.current
    ) {
      return
    }
    if (options?.ifActivationVersion !== undefined) {
      const focusedRow = document.activeElement instanceof Element
        ? document.activeElement.closest<HTMLElement>("[data-cell-id]")
        : null
      if (focusedRow?.dataset.cellId && focusedRow.dataset.cellId !== cellId) {
        return
      }
    }
    if (activeEditorCellIdRef.current !== cellId) {
      editorActivationVersionRef.current += 1
    }
    activeEditorCellIdRef.current = cellId
    setActiveEditorCellId(cellId)
    lastActiveEditorCellIdRef.current = cellId
  }, [])

  const getEditorActivationVersion = useCallback(
    () => editorActivationVersionRef.current,
    [],
  )

  const handleDeactivateEditor = useCallback((cellId: string) => {
    if (activeEditorCellIdRef.current === cellId) {
      activeEditorCellIdRef.current = null
    }
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

  // Cell-level quality estimates are noisy. Present a symmetric local trend
  // instead of a progress ring, while keeping the three evidence stages
  // separate so validated 100s never inflate nearby automatic estimates.
  //
  // AQU-1104: inputs are cached per cell on the store's per-cell version, so a
  // commit re-derives only the cells it touched instead of every view in the
  // file. The smoothing pass itself still runs over the whole list; it is a
  // few arithmetic operations per cell.
  // The cache is keyed to the store instance: per-cell versions are only
  // comparable within one store, so a new store gets a fresh cache.
  const ribbonInputCache = useMemo<RibbonInputCache>(() => ribbonInputCacheFor(cellStore), [cellStore])
  const healthCalculationsEnabled = useHealthCalculationsEnabled()
  const healthRibbonByCellId = useMemo(() =>
    !healthCalculationsEnabled ? EMPTY_RIBBON :
    readAtVersion(cellStoreVersion, () => ribbonInputCache.ribbon<CellData>(displayCellIds, {
      getCellVersion: cellStore.getCellVersion,
      getCell: (id) => cellStore.getCellView(id),
      sourceText: effectiveSourceText,
      health: (id) => healthMap.get(id),
      examples: (id) => examples.get(id) ?? EMPTY_EXAMPLES,
    })),
  [cellStore, cellStoreVersion, displayCellIds, examples, healthCalculationsEnabled, healthMap, ribbonInputCache])

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
    // A native smooth animation emits scroll events far past any single
    // stamp — while one of OUR scrolls is in flight, every event renews the
    // stamp so the truce can't misread the animation as the user leaving.
    if (programmaticInFlightRef.current > 0) {
      followProgrammaticStampRef.current = performance.now()
    }
    // Wire c: every scroll event reaches the follow driver's truce check
    // (it distinguishes its own programmatic scrolls by the stamp).
    followUserScrollListenerRef.current?.()
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
    handleActivateEditor(targetId)
    // Navigating to EDIT a cell releases follow — playback must not yank the
    // row out from under the caret (pre-round behavior, now explicit).
    programmaticListScroll(index, { viewPosition: 0.5, animated: false, follow: "release" })

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
      // Ordinary rich-text cells: put the native caret at the end so Tab/↑/↓
      // land where the user expects to keep typing. IDML cells must NOT use
      // selectNodeContents/collapse — empty protected slots render a browser
      // trailing <br>, so "end" paints on a phantom second line and desyncs
      // ProseMirror's selection (typed characters then insert in reverse).
      // TranslatedEditor.onFocus places the caret inside the first editable slot.
      if (pm.querySelector("[data-idml-version]")) return
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
  }, [clearChapterNavigationSelection, getListQueryRoot, handleActivateEditor, programmaticListScroll])

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

  // AQU-646 round 8: two short beats on a set of rows, with NO selection — the
  // gap-click's "look here" for the lines on either side of a silence. Removing
  // the class first is what lets a second click on the same pair re-fire it;
  // re-adding a class the node already carries restarts nothing.
  const pulseCellsDom = useCallback((cellIds: readonly string[]) => {
    if (cellIds.length === 0) return
    requestAnimationFrame(() => {
      const root = getListQueryRoot()
      if (!root) return
      for (const cellId of cellIds) {
        const el = root.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`)
        if (!el) continue
        el.classList.remove("codex-gap-pulse")
        // Force a reflow so the removal is committed before the re-add.
        void el.offsetWidth
        el.classList.add("codex-gap-pulse")
        window.setTimeout(() => el.classList.remove("codex-gap-pulse"), 600)
      }
    })
  }, [getListQueryRoot])

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < displayCellIds.length) {
        clearChapterNavigationSelection()
        programmaticListScroll(index, { viewPosition: 0.5, animated: false })
      }
    },
    scrollToCellId(cellId, opts) {
      // AQU-646 round 3: id-based scroll in DISPLAY space. The older
      // index-based path resolved indexes via cellStore.findIndexByCellId —
      // STORE order — but the list renders displayCellIds, which time-ordered
      // files re-sort by timing, so those jumps could land on the wrong row.
      const index = displayCellIdsRef.current.indexOf(cellId)
      if (index < 0) return revealCellPage(cellId)
      clearChapterNavigationSelection()
      // Default "release": a jump the user is INSPECTING (search, presence,
      // findings) must not have playback yank the table back a beat later.
      // Wire a (chip clicks) passes "engage" — that jump means "watch this".
      programmaticListScroll(index, {
        viewPosition: 0.5,
        animated: false,
        follow: opts?.follow ?? "release",
      })
      if (opts?.flash) flashCellDom(cellId)
      return true
    },
    setMediaFollow(intent: "engage" | "release") {
      issueFollowCommand(intent)
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
    pulseCells(cellIds) {
      pulseCellsDom(cellIds)
    },
  }), [clearChapterNavigationSelection, displayCellIds.length, cellStore, focusCellEditorByIndex, getListQueryRoot, flashCellDom, pulseCellsDom, programmaticListScroll, issueFollowCommand, revealCellPage])

  // FRO-297: Focus the grid-row wrapper div (not TipTap) at `index`.
  // Used for Esc-to-grid and arrow-key navigation while NOT in edit mode.
  // The wrapper div has tabIndex={0} so it can receive programmatic focus.
  const focusGridRowByIndex = useCallback((index: number) => {
    const list = displayCellIdsRef.current
    if (index < 0 || index >= list.length) return
    const targetId = list[index]
    clearChapterNavigationSelection()
    // Grid-focus navigation is editing intent too — release follow.
    programmaticListScroll(index, { viewPosition: 0.5, animated: false, follow: "release" })
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
  }, [clearChapterNavigationSelection, getListQueryRoot, programmaticListScroll])

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

  // Grid layout: [gutter] [source] [target]. The gutter is one fixed track
  // holding select + status-badges (flex-col) + verse number in a tight
  // flex row (gap-0.5) — tighter than three gap-2 grid tracks, while the
  // fixed width keeps Source header-aligned. No right gutter; the floating
  // action rail is absolutely positioned. Target reserves pe-9 for the
  // expand chevron.
  const gridCols: EditorGridCols = castGutter
    ? "grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
    : "grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"

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

  const currentMilestoneKey = useMemo(() => {
    const visibleIndex = chapterVisibleIndex ?? firstVisibleIndex
    const cellId = displayCellIds[visibleIndex]
    return milestoneKeyByCellId.get(cellId ?? "") ?? milestoneNavigation[0]?.key ?? ""
  }, [chapterVisibleIndex, displayCellIds, firstVisibleIndex, milestoneKeyByCellId, milestoneNavigation])

  const milestoneNavigationItems = useMemo<MilestoneNavigationItem[]>(() =>
    readAtVersion(cellStoreVersion, () => {
      return milestoneNavigation.map((entry) => {
        const verseLabels = entry.cellIds
          .map((cellId) => verseLabelFromCanonical(cellStore.getCellView(cellId)?.group))
          .filter((label): label is string => Boolean(label))
        const firstVerse = verseLabels[0] ?? null
        const lastVerse = verseLabels[verseLabels.length - 1] ?? null
        const range = firstVerse && lastVerse
          ? firstVerse === lastVerse ? firstVerse : `${firstVerse}–${lastVerse}`
          : null
        const unitName = entry.kind === "time-range" ? "segment" : "cell"
        const description = entry.kind === "story" && range
          ? `Frames ${range}`
          : (
            entry.kind === "chapter"
            || entry.kind === "chapter-range"
            || entry.kind === "preface"
          ) && range
            ? `Verses ${range}`
            : `${entry.total} ${unitName}${entry.total === 1 ? "" : "s"}`
        return {
          key: entry.key,
          kind: entry.kind,
          label: entry.label,
          shortLabel: entry.shortLabel,
          description,
          translated: entry.translated,
          validated: entry.validated,
          total: entry.total,
          ...(idmlMilestoneNavigation
            ? {
                subsections: entry.subsections.map((subsection) => ({
                  key: subsection.key,
                  label: subsection.label,
                  firstCellId: subsection.firstCellId,
                  translated: subsection.translated,
                  validated: subsection.validated,
                  total: subsection.total,
                })),
              }
            : {}),
        }
      })
    }),
  [cellStore, cellStoreVersion, idmlMilestoneNavigation, milestoneNavigation])

  // AQU-610: sequential (non-scripture) numbering counts only *numbered*
  // (non-paratext) cells, so the count starts at 1 at the first real content
  // cell and stays gap-free even when front matter, introductions, or other
  // paratextual cells sit before/among the content. Scripture files number by
  // canonical verse ref and don't consult this map.
  // AQU-1146: per-cell "does this cell get a sequential number" is a
  // structural fact (type + import metadata) that never changes on an
  // ordinary target edit — cache it per cell, keyed by the store's per-cell
  // version (same idiom as `ribbonInputCache` in ribbon-inputs.ts), so a
  // commit that touches a handful of cells re-derives only those cells
  // instead of re-resolving every cell view in the file. The ordinal count
  // itself is still one cheap linear pass — only the `getCellView` +
  // metadata check is skipped for unchanged cells.
  const sequentialEntryCacheRef = useRef<Map<string, { version: number; isNumbered: boolean }>>(new Map())
  const sequentialNumberByCellId = useMemo(() =>
    readAtVersion(cellStoreVersion, () => {
      const cache = sequentialEntryCacheRef.current
      const nextCache = new Map<string, { version: number; isNumbered: boolean }>()
      const map = new Map<string, number>()
      let ordinal = 0
      for (const id of fileCellIds) {
        const version = cellStore.getCellVersion(id)
        let entry = cache.get(id)
        if (!entry || entry.version !== version) {
          const view = cellStore.getCellView(id)
          const isNumbered = view != null
            && view.type !== "paratext"
            && view.type !== "heading"
            && importDisplayLabel(view.metadata) !== null
          entry = { version, isNumbered }
        }
        nextCache.set(id, entry)
        if (entry.isNumbered) map.set(id, ++ordinal)
      }
      sequentialEntryCacheRef.current = nextCache
      return map
    }),
  [cellStore, cellStoreVersion, fileCellIds])

  // p1-paragraph-ui-wiring (Task 3 + coordinator follow-up): paragraph group
  // info, keyed by the group's start cell id — drives the "Draft paragraph"
  // rail button's visibility/label/dialog copy and its in-flight guard. Only
  // start cells (the only ones the button can render on) need an entry, but
  // deriveParagraphs needs the full ordered per-file cell list to find file/
  // paragraph boundaries, so this walks fileCellIds once, same idiom as
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
  // AQU-1146: same per-cell version cache idiom as sequentialNumberByCellId
  // above. `fileId`/`paragraphStart` are structural (import-time) facts;
  // `validated` changes on an ordinary commit but is cheap to carry in the
  // same cached entry, which also means the draftable-count pass below reads
  // it from the cache instead of calling `getCellView` a second time per
  // group member.
  const paragraphEntryCacheRef = useRef<
    Map<string, { version: number; fileId: string; paragraphStart?: boolean; validated: boolean }>
  >(new Map())
  const paragraphGroupInfoByCellId = useMemo(() =>
    readAtVersion(cellStoreVersion, () => {
      const cache = paragraphEntryCacheRef.current
      const nextCache = new Map<string, { version: number; fileId: string; paragraphStart?: boolean; validated: boolean }>()
      const orderedCells: { id: string; fileId: string; paragraphStart?: boolean }[] = []
      for (const id of fileCellIds) {
        const version = cellStore.getCellVersion(id)
        let entry = cache.get(id)
        if (!entry || entry.version !== version) {
          const view = cellStore.getCellView(id)
          if (!view) continue
          entry = { version, fileId: view.fileId, paragraphStart: view.paragraphStart, validated: view.status === "validated" }
        }
        nextCache.set(id, entry)
        orderedCells.push({ id, fileId: entry.fileId, paragraphStart: entry.paragraphStart })
      }
      paragraphEntryCacheRef.current = nextCache
      const map = new Map<string, { size: number; draftableCount: number; memberIds: string[] }>()
      for (const group of deriveParagraphs(orderedCells)) {
        if (group.length <= 1) continue
        let draftableCount = 0
        for (const id of group) {
          if (!nextCache.get(id)?.validated) draftableCount++
        }
        map.set(group[0], { size: group.length, draftableCount, memberIds: group })
      }
      return map
    }),
  [cellStore, cellStoreVersion, fileCellIds])

  const viewportCellId = displayCellIds[chapterVisibleIndex ?? firstVisibleIndex]
  const currentSubsectionKey = subsectionKeyByCellId.get(viewportCellId ?? "")
  const selectedChapterLabel = chapterNavigationSelection?.fileId === audioFileId
    ? chapterNavigationSelection.label
    : null
  const activeChapterLabel = resolveActiveChapterLabel(
    milestoneNavigationItems.map((milestone) => milestone.key),
    currentMilestoneKey,
    selectedChapterLabel,
  )
  const activeSubsectionKey = (
    chapterNavigationSelection?.fileId === audioFileId
    && chapterNavigationSelection.label === activeChapterLabel
    && chapterNavigationSelection.subsectionKey
  ) || currentSubsectionKey

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

  const handleChapterSelect = useCallback((key: string, subsectionKey?: string) => {
    const entry = milestoneNavigation.find((candidate) => candidate.key === key)
    const subsection = idmlMilestoneNavigation
      ? entry?.subsections.find((candidate) => candidate.key === subsectionKey)
      : undefined
    const targetCellId = subsection?.firstCellId ?? entry?.firstCellId
    if (!targetCellId) return
    setChapterNavigationSelection({
      fileId: audioFileId,
      label: key,
      ...(subsection ? { subsectionKey: subsection.key } : {}),
    })
    if (splitByMilestone) {
      pendingJumpCellIdRef.current = targetCellId
      return
    }
    const index = subsection?.firstIndex ?? entry?.firstIndex ?? -1
    if (index < 0) return
    setFirstVisibleIndex(index)
    setChapterVisibleIndex(index)
    // Picking a range mid-playback is deliberate navigation AWAY — release
    // following (its long smooth scroll used to trip the truce as a fake
    // "user scroll" and kill follow as a side effect; now it's explicit).
    programmaticListScroll(index, { viewPosition: 0, animated: true, follow: "release" })
  }, [audioFileId, idmlMilestoneNavigation, milestoneNavigation, programmaticListScroll, splitByMilestone])

  // Settings can flip the split pref while this table is still mounted
  // (the settings dialog sits over the editor). Pin the current visible
  // cell's division before paint so paging does not jump to the first
  // milestone.
  useLayoutEffect(() => {
    if (!splitByMilestone || !audioFileId) return
    const selected = chapterNavigationSelection?.fileId === audioFileId
      ? chapterNavigationSelection
      : null
    if (selected?.label && milestoneNavigation.some((entry) => entry.key === selected.label)) {
      return
    }
    const visibleId = fileCellIds[chapterVisibleIndex ?? firstVisibleIndex]
    const key = (visibleId && milestoneKeyByCellId.get(visibleId)) ?? milestoneNavigation[0]?.key
    if (!key) return
    const subsectionKey = idmlMilestoneNavigation && visibleId
      ? subsectionKeyByCellId.get(visibleId)
      : undefined
    if (visibleId) pendingJumpCellIdRef.current = visibleId
    setChapterNavigationSelection({
      fileId: audioFileId,
      label: key,
      ...(subsectionKey ? { subsectionKey } : {}),
    })
  }, [
    audioFileId,
    chapterNavigationSelection,
    chapterVisibleIndex,
    fileCellIds,
    firstVisibleIndex,
    idmlMilestoneNavigation,
    milestoneKeyByCellId,
    milestoneNavigation,
    splitByMilestone,
  ])

  useLayoutEffect(() => {
    const cellId = pendingJumpCellIdRef.current
    if (!cellId) return
    const index = displayCellIds.indexOf(cellId)
    if (index < 0) {
      pendingJumpCellIdRef.current = null
      return
    }
    pendingJumpCellIdRef.current = null
    setFirstVisibleIndex(index)
    setChapterVisibleIndex(index)
    programmaticListScroll(index, { viewPosition: 0, animated: false, follow: "release" })
  }, [displayCellIds, programmaticListScroll])

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

  useEffect(() => {
    if (!onVisibleCellIdsChange) return

    // LegendList does not always deliver an initial viewability callback when
    // it restores a short list whose rows all fit in the viewport. That left
    // translate-as-read with an empty viewport even though the rows were
    // visibly mounted. Prefer LegendList's indexes when available, but fall
    // back to the actual rendered/intersecting rows so the UI itself remains
    // the source of truth.
    const report = () => {
      const indexedIds = viewableIndexes
        .map((index) => displayCellIds[index])
        .filter((cellId): cellId is string => Boolean(cellId))
      if (indexedIds.length > 0) {
        onVisibleCellIdsChange(indexedIds)
        return
      }

      const viewport = parentRef.current ?? listRootRef.current
      const root = listRootRef.current ?? parentRef.current
      if (!viewport || !root) {
        onVisibleCellIdsChange([])
        return
      }
      const viewportRect = viewport.getBoundingClientRect()
      const renderedRows = Array.from(
        root.querySelectorAll<HTMLElement>("[data-cell-id][data-index]"),
      )
      const renderedIds = renderedRows
        .filter((row) => {
          const rect = row.getBoundingClientRect()
          return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
        .map((row) => row.dataset.cellId)
        .filter((cellId): cellId is string => Boolean(cellId))
      onVisibleCellIdsChange(renderedIds)
    }

    report()
    const frame = requestAnimationFrame(report)
    const viewport = parentRef.current ?? listRootRef.current
    viewport?.addEventListener("scroll", report, { passive: true })
    const observer = typeof ResizeObserver === "undefined" || !viewport
      ? null
      : new ResizeObserver(report)
    if (observer && viewport) observer.observe(viewport)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener("scroll", report)
      observer?.disconnect()
      onVisibleCellIdsChange([])
    }
  }, [displayCellIds, onVisibleCellIdsChange, viewableIndexes])

  const getFootnoteDetails = useCallback(
    (cellId: string) => cellStore.getCellFootnotes(cellId),
    [cellStore],
  )

  const renderListItem = useCallback(({ item: cellId, index }: LegendListRenderItemProps<string>) => {
    const audioEntry = audioByCellId.get(cellId)
    const backtranslation = backtranslationByCellId?.get(cellId)
    const linkedTakes = linkedTakesByCell?.get(cellId)
    return (
      <CellStoreRow
        cellId={cellId}
        cellStore={cellStore}
        audioEntry={audioEntry}
        backtranslation={backtranslation}
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
          // AQU-1146: resolved here (once per rendered row) instead of inside
          // MemoizedRow so the row's props stay per-cell scalars — see
          // `MemoizedRowProps.paragraphGroupInFlight`.
          const paragraphGroupInFlight = paragraphGroupInfo?.memberIds?.some((id) => {
            const state = completing.get(id)
            return state === "searching" || state === "generating"
          }) ?? false
          // AQU-646: the row's STRUCTURAL controls — add a line into the
          // silence after it, take an empty added line back. One map lookup and
          // one predicate call per row; no scans.
          //
          // `insertAbove` reaches only the first row, because that is the only
          // row with a silence in front of it — everywhere else "above me" is
          // "below my predecessor", which that row already offers.
          const insertBelow = sourceLineEditing?.afterCell.get(cell.id) ?? null
          const insertAbove = index === 0 ? (sourceLineEditing?.head ?? null) : null
          const canRemoveLine = Boolean(sourceLineEditing?.canRemove(cell))
          return (
      <div
        data-cell-id={cell.id}
        data-index={index}
        data-untimed={untimedInTimeLens ? "true" : undefined}
        data-paragraph-start={showParagraphBoundary ? "true" : undefined}
        aria-label={untimedInTimeLens ? t("editor.row.noTimingAria") : undefined}
        className={cn(
          "relative",
          // The hover group for the structural strip below. Named so it cannot
          // be caught by the row's other `group` users.
          (insertBelow || insertAbove || canRemoveLine) && "group/rowstrip",
          untimedInTimeLens && "border-s-2 border-dashed border-amber-400/70",
          showParagraphBoundary && "mt-3",
        )}
      >
        {sourceLineEditing && (
          <RowStructureCorner
            testId={`row-structure-${cell.id}`}
            insertBelow={insertBelow}
            insertAbove={insertAbove}
            onAddLine={sourceLineEditing.onAddLine}
            onRemove={canRemoveLine ? () => sourceLineEditing.onRemoveLine(cell.id) : undefined}
            removeTestId={`row-remove-${cell.id}`}
          />
        )}
        {untimedInTimeLens && (
          <span className="pointer-events-none absolute start-1 top-1 z-10 rounded bg-amber-400/15 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400">
            {t("editor.row.noTimingBadge")}
          </span>
        )}
        {showParagraphBoundary && (
          <div className={`grid ${gridCols} border-t border-border/60 ps-2.5 pe-4`}>
            {/* Pilcrow sits in the number slot of the combined gutter so it
                stays aligned with line numbers below. */}
            <div className="flex items-center py-1">
              {castGutter && <div className="me-2 w-10 shrink-0" aria-hidden="true" />}
              <div className="w-5 shrink-0" aria-hidden="true" />
              <div className="ms-2 flex min-w-0 flex-1 items-center gap-0.5">
                <div className="w-5 shrink-0" aria-hidden="true" />
                <AppTooltip content={t("editor.row.newParagraph")}>
                  <div
                    data-testid="paragraph-boundary-indicator"
                    className="flex min-w-0 flex-1 items-center justify-center"
                  >
                    <Pilcrow className="h-3 w-3 text-muted-foreground" />
                  </div>
                </AppTooltip>
              </div>
            </div>
          </div>
        )}
        <MemoizedRow
          key={cell.id}
          project={project}
          cell={cell}
          linkedTakes={linkedTakes}
          isEditorActive={activeEditorCellId === cell.id}
          isRowFocused={isRailFocusPinned(focusedRailCellId, cell.id)}
          onRowFocusPin={handleRowFocusPin}
          onRowFocusRelease={handleRowFocusRelease}
          onClearCellErrors={onClearCellErrors}
          onActivateEditor={handleActivateEditor}
          getEditorActivationVersion={getEditorActivationVersion}
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
          cellExamples={examples.get(cell.id) ?? EMPTY_EXAMPLES}
          completingState={completing.get(cell.id)}
          cellError={errors.get(cell.id)}
          previewText={previews.get(cell.id)}
          healthRibbonPoint={healthRibbonByCellId.get(cell.id) ?? HEALTH_DISABLED_POINT}
          infractions={infractions}
          ruleMap={ruleMap}
          onCompleteSingle={onCompleteSingle}
          onCompleteParagraph={onCompleteParagraph}
          paragraphGroupSize={paragraphGroupInfo?.size}
          paragraphDraftableCount={paragraphGroupInfo?.draftableCount}
          paragraphGroupInFlight={paragraphGroupInFlight}
          isBacktranslationConfigured={isBacktranslationConfigured}
          backtranslating={backtranslating}
          backtranslationErrors={backtranslationErrors}
          onBacktranslate={onBacktranslate}
          onSaveBacktranslation={onSaveBacktranslation}
          getStatisticalBt={getStatisticalBt}
          getFootnoteDetails={getFootnoteDetails}
          cellOpenCommentCount={cellOpenCommentCount}
          onSeekToCue={onSeekToCue}
          rowIndex={index}
          contentNumber={sequentialNumberByCellId.get(cell.id) ?? index + 1}
          lineNumbersEnabled={lineNumbersEnabled}
          scriptureNumbering={milestoneNavigationItems.every((item) => (
            item.kind === "chapter"
            || item.kind === "chapter-range"
            || item.kind === "preface"
          ))}
          cellLabelsEnabled={cellLabelsEnabled}
          sourceDirectionMode={sourceDirectionMode}
          targetDirectionMode={targetDirectionMode}
          sourceTextDirection={sourceTextDirection}
          targetTextDirection={targetTextDirection}
          gridCols={gridCols}
          castGutter={castGutter}
          ttsSettings={ttsSettings}
          isAnonymous={isAnonymous}
          onJumpToCell={onJumpToCell}
          micDenied={micDenied}
          audioLens={audioLens ?? null}
          onOpenAudioSetup={onOpenAudioSetup}
          onProjectChanged={onProjectChanged}
          onAddConceptFromSelection={onAddConceptFromSelection}
          addConceptBlockedReason={addConceptBlockedReason}
        canApproveConcept={canApproveConcept}
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
          showFootnotesInline={showFootnotesInline}
          footnotePanelActive={footnotePanelActive}
          footnoteViewMode={footnoteViewMode}
          targetKeyTermHighlightMode={targetKeyTermHighlightMode}
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
    sourceLineEditing,
    activeEditorCellId,
    castGutter,
    ttsSettings,
    focusedRailCellId,
    handleRowFocusPin,
    handleRowFocusRelease,
    onClearCellErrors,
    activeLane,
    audioByCellId,
    audioLens,
    castGutter,
    ttsSettings,
    backtranslationByCellId,
    linkedTakesByCell,
    backtranslating,
    backtranslationErrors,
    canEdit,
    canEditSource,
    canValidate,
    cellStore,
    cellLockHolders,
    cellOpenCommentCount,
    cellsWithRemoteChange,
    completing,
    displayCellIds,
    errors,
    examples,
    footnotePanelActive,
    footnoteViewMode,
    targetKeyTermHighlightMode,
    getTokenForFile,
    getAlignmentModel,
    getStatisticalBt,
    getVoiceTakeCells,
    gridCols,
    handleDragEnter,
    handleDragStart,
    handleActivateEditor,
    getEditorActivationVersion,
    handleDeactivateEditor,
    handleEscapeToGrid,
    handleGridRowKeyNav,
    handleNavigateCell,
    handleSelectionPointerDown,
    healthRibbonByCellId,
    infractions,
    isAnonymous,
    isBacktranslationConfigured,
    isCompletionAvailable,
    isCompletionConfigured,
    isTimeOrdered,
    milestoneNavigationItems,
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
    t,
  ])
  const listExtraData = useMemo(
    () => ({ cellStoreVersion, renderListItem }),
    [cellStoreVersion, renderListItem],
  )

  const showMilestoneNav = !castGutter && milestoneNavigationItems.length > 0 && Boolean(activeChapterLabel)
  const showStripNav = castGutter && milestoneNavigationItems.length > 0 && Boolean(activeChapterLabel)
  // The strip registers its slot by name — it is itself portaled into the
  // media band (one commit after this table), so the old one-shot
  // querySelector in a mount effect would run too early and never retry.
  const stripNavSlot = useUiSlot("strip-nav")

  const renderChapterNavigation = () => {
    if (!showMilestoneNav && !chapterNavTrailing) return null

    return (
      <div
        data-testid="editor-chapter-row"
        className={EDITOR_SURFACE_TOOLBAR_CLASS}
      >
        {showMilestoneNav ? (
          <div className="hidden min-w-0 flex-1 lg:block" aria-hidden="true" />
        ) : null}
        {showMilestoneNav ? (
          <div
            data-chapter-nav-slot=""
            className="me-auto flex min-w-24 max-w-full flex-1 items-center lg:me-0 lg:flex-none lg:shrink"
          >
            <div className="min-w-0 max-w-full w-full lg:w-auto">
              <MilestoneNavigator
                items={milestoneNavigationItems}
                activeKey={activeChapterLabel!}
                activeSubsectionKey={activeSubsectionKey}
                onSelect={handleChapterSelect}
                pageByMilestone={splitByMilestone}
              />
            </div>
          </div>
        ) : null}
        {chapterNavTrailing ? (
          <div
            className={cn(
              "flex shrink-0 items-center",
              showMilestoneNav ? "lg:flex-1 lg:justify-end" : "ms-auto",
            )}
          >
            {chapterNavTrailing}
          </div>
        ) : showMilestoneNav ? (
          <div className="hidden min-w-0 flex-1 lg:block" aria-hidden="true" />
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onMouseUp={handleMouseUp}>
      {showStripNav && stripNavSlot
        ? createPortal(
            <div className="flex min-w-0 items-center gap-2">
              <MilestoneNavigator
                items={milestoneNavigationItems}
                activeKey={activeChapterLabel}
                activeSubsectionKey={activeSubsectionKey}
                onSelect={handleChapterSelect}
                pageByMilestone={splitByMilestone}
              />
            </div>,
            stripNavSlot,
          )
        : null}
      <div className="shrink-0 bg-background">
        {/* FRO-273: role badge — shown for read-only roles (viewer/commenter/reviewer) */}
        {readOnlyLabel && (
          <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-shrink-0"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            {readOnlyLabel}
          </div>
        )}
        {renderChapterNavigation()}
        <div className={cn("grid gap-2 border-b border-border ps-2.5 pe-4 py-2 text-xs font-medium text-muted-foreground", gridCols)}>
          {/* With the character gutter on, the Source label sits over the
              gutter at the LEFT EDGE (Sam 2026-08-07) instead of floating a
              gutter-width away from the side; otherwise the track is
              unlabeled (select + badges + number). */}
          {castGutter ? (
            <div data-testid="table-source-header" className="flex items-center gap-2">
              {t("editor.column.source")}
              {project.sourceLanguage && (
                <Badge variant="secondary" className="text-[10px] font-normal normal-case tracking-normal">
                  {project.sourceLanguage}
                </Badge>
              )}
            </div>
          ) : (
            <div aria-hidden="true" />
          )}
          {/* In Audio mode the left column carries per-line voice controls, not
              source text, so label it "Controls" (no source-language badge). */}
          <div className="flex items-center gap-2 ps-2">
            {castGutter ? null : audioLens ? t("editor.column.controls") : t("editor.column.source")}
            {!castGutter && !audioLens && project.sourceLanguage && (
              <Badge variant="secondary" className="text-[10px] font-normal normal-case tracking-normal">
                {project.sourceLanguage}
              </Badge>
            )}
          </div>
          <div data-testid="table-target-header" className="relative flex items-center gap-2 ps-6 pe-2">
            {t("editor.column.target")}
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
              /* AQU-609: the switcher is a searchable combobox — client
                 projects carry 150+ lanes, and lane switching is a combobox
                 by explicit client request. Archived-lane semantics (AQU-601)
                 live in LaneCombobox: hidden behind a reveal while browsing,
                 searchable always, auto-revealed when the active lane is
                 archived. */
              <LaneCombobox
                options={(lanes ?? []).map((lane) => ({
                  value: lane,
                  label: lane === "" ? (defaultLaneLabel || t("editor.column.target")) : lane,
                  archived: isLaneArchived(lane, archivedLanes),
                  testId: lane,
                }))}
                value={activeLane}
                onValueChange={onLaneChange}
                searchPlaceholder={t("editor.lane.searchPlaceholder")}
                searchAriaLabel={t("editor.lane.searchAriaLabel")}
                emptyText={t("editor.lane.searchEmpty")}
                align="end"
                trigger={
                  <button
                    type="button"
                    data-testid="lane-switcher"
                    data-active-lane={activeLane}
                    aria-label={t("editor.lane.activeAria")}
                    className={cn(
                      badgeVariants({ variant: "secondary" }),
                      "gap-1 text-[10px] font-normal normal-case tracking-normal transition-colors hover:bg-muted-foreground/20 hover:text-foreground",
                    )}
                  >
                    {/* AQU-583: on the default lane with no project target set,
                        `project.targetLanguage` is empty — prompt to set one
                        rather than showing a blank pill. A named lane always
                        has a tag. */}
                    {project.targetLanguage || t("editor.lane.setTargetLanguage")}
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                }
                footer={
                  onEditTargetLanguage
                    ? (close) => (
                        /* AQU-583: manage the default target language from the
                           switcher. */
                        <button
                          type="button"
                          data-testid="edit-target-language"
                          onClick={() => {
                            close()
                            onEditTargetLanguage()
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                        >
                          <Languages className="h-3.5 w-3.5" />
                          {t("editor.lane.changeTargetLanguageItem")}
                        </button>
                      )
                    : undefined
                }
              />
            ) : onEditTargetLanguage ? (
              <button
                type="button"
                data-testid="edit-target-language"
                onClick={onEditTargetLanguage}
                aria-label={project.targetLanguage ? t("editor.lane.changeTargetLanguage") : t("editor.lane.setTargetLanguage")}
                className="flex items-center gap-1 rounded-lg bg-muted px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {project.targetLanguage || t("editor.lane.setTargetLanguage")}
                <Languages className="h-2.5 w-2.5" />
              </button>
            ) : project.targetLanguage ? (
              <Badge variant="secondary" className="text-[10px] font-normal normal-case tracking-normal">
                {project.targetLanguage}
              </Badge>
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
          {mediaSyncActive && (
            <MediaFollowDriver
              isCellDisplayed={followIsCellDisplayed}
              scrollToCell={followScrollToCell}
              userScrollListenerRef={followUserScrollListenerRef}
              programmaticStampRef={followProgrammaticStampRef}
              followCommand={followCommand}
              onFollowRest={handleFollowRest}
            />
          )}
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
        // 2026-08-07: keyed on isTimeOrdered, not audioLens — the media lens
        // renders this table in text mode under the timeline now, and an empty
        // time-ordered file must still offer "attach a clip" there.
        canEdit && onAttachMediaFile && onAttachMediaUrl ? (
          <div className="flex-1">
            <TimelineAddMedia onAttachFile={onAttachMediaFile} onAttachUrl={onAttachMediaUrl} />
          </div>
        ) : (
          <div className="flex-1">
            <EmptyState
              variant="inline"
              className="h-full py-10"
              icon={Music}
              title={t("editor.empty.noMediaSegments")}
              description={t("editor.empty.mediaLayerHint")}
            />
          </div>
        )
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
})

/**
 * AQU-646: the row's structural controls — "add a line into the silence here"
 * and "take this line back" — as a PAIR in the row's bottom-right corner.
 *
 * Round 9 rewrote this twice-over, and both mistakes are worth keeping written
 * down. First cut hung a hover-revealed strip 12px BELOW the row so it would
 * straddle the divider: the virtualised list wraps every row in a container
 * carrying `contain: content`, which implies PAINT containment, so the 12px
 * outside the row was simply clipped away and the control was invisible in a
 * real browser. Unit tests cannot catch that — happy-dom has no layout engine,
 * so a clipped element still measures as present. Second cut moved it inside
 * the row but left it centred and hover-only, which read as a stray pencil
 * floating in the middle of the row; Sam could not tell what it was.
 *
 * What it is now, per Sam's markup: two SQUARES in the bottom-right corner,
 * `[x][+]` — remove on the left, insert on the right. Always visible at half
 * opacity so the affordance is discoverable without hunting, full opacity when
 * the pointer is anywhere on the row.
 *
 * The corner is chosen, not incidental. The row's TOP-right is already the
 * action rail's (`absolute right-2 top-0.5 z-20`) with its always-on chevron
 * and attention dot, and the target column reserves `pr-9` for that lane. The
 * bottom-right is the only free corner, and it is out of the text's way.
 *
 * Deliberately NOT the timeline's round slot button. That one is a hover-only
 * affordance over an empty stretch of track; this is persistent row chrome. The
 * two surfaces asking the same question does not make them the same control.
 */
function RowStructureCorner({
  testId,
  /** The silence after this row. Null = no room, so no `+` AT ALL — never a
   *  disabled one. The same "no room, no add" rule the timeline's pencil obeys. */
  insertBelow,
  /** The silence before the FIRST cue. Only ever passed to the first row. */
  insertAbove,
  onAddLine,
  onRemove,
  removeTestId,
}: {
  testId: string
  insertBelow: { startSec: number; endSec: number } | null
  insertAbove: { startSec: number; endSec: number } | null
  onAddLine(startSec: number, endSec: number): void
  onRemove?: () => void
  removeTestId?: string
}) {
  // Above the early return: a hook after one runs in a different order on the
  // renders that bail out, which is the rules-of-hooks error this was.
  const t = useT()
  if (!insertBelow && !insertAbove && !onRemove) return null
  // Both directions available (only ever the first row, and only while the
  // file still opens on a silence) — the button has to ask which. One
  // direction available: just do it. A one-item menu is a click for nothing.
  const needsMenu = Boolean(insertAbove && insertBelow)
  const square =
    "flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute right-2 bottom-1 z-20 flex items-center gap-1",
        // Half-visible at rest; the whole row is the hover target, so reaching
        // for the corner lights it before you arrive.
        "opacity-50 transition-opacity group-hover/rowstrip:opacity-100 focus-within:opacity-100",
      )}
    >
      {onRemove && (
        <button
          type="button"
          title={t("editor.row.removeLine")}
          aria-label={t("editor.row.removeLine")}
          data-testid={removeTestId ?? `${testId}-remove`}
          className={square}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {(insertBelow || insertAbove) &&
        (needsMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  title={t("editor.row.addLine")}
                  aria-label={t("editor.row.addLine")}
                  data-testid={`${testId}-add`}
                  className={square}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-[9rem]">
              <DropdownMenuItem
                data-testid="row-insert-above"
                onClick={() => onAddLine(insertAbove!.startSec, insertAbove!.endSec)}
              >
                <ArrowUp className="mr-2 h-3.5 w-3.5" />
                {t("editor.row.insertAbove")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="row-insert-below"
                onClick={() => onAddLine(insertBelow!.startSec, insertBelow!.endSec)}
              >
                <ArrowDown className="mr-2 h-3.5 w-3.5" />
                {t("editor.row.insertBelow")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button
            type="button"
            title={insertAbove ? t("editor.row.addLineAbove") : t("editor.row.addLineBelow")}
            aria-label={insertAbove ? t("editor.row.addLineAbove") : t("editor.row.addLineBelow")}
            data-testid={`${testId}-add`}
            className={square}
            onClick={(e) => {
              e.stopPropagation()
              const span = insertBelow ?? insertAbove!
              onAddLine(span.startSec, span.endSec)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ))}
    </div>
  )
}

interface CellStoreRowProps {
  cellId: string
  cellStore: CellStore
  audioEntry?: CellAudioEntry
  backtranslation?: BacktranslationRecord
  projectId?: string | null
  children: (cell: CellData) => React.ReactNode
}

function CellStoreRow({
  cellId,
  cellStore,
  audioEntry,
  backtranslation,
  projectId,
  children,
}: CellStoreRowProps) {
  const cell = useCellView(cellStore, cellId)
  const hydratedCell = useMemo(() => {
    if (!cell) return null
    return applyRowOverlays(cell, { audioEntry, backtranslation, projectId })
  }, [audioEntry, backtranslation, cell, projectId])

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
  /** The heard lines performing this row that hold a recording — see
   *  `linkedTakesByCell` on the table's props. */
  linkedTakes?: LinkedTake[]
  isEditorActive: boolean
  /** AQU-669: this cell is the single exclusive focus-pin owner (its id equals
   *  the table's `focusedRailCellId`). Drives the rail's focus pin so a stale
   *  focus-out on some other row can never keep its rail revealed. */
  isRowFocused: boolean
  /** AQU-669: called when focus enters this row — sets the exclusive owner. */
  onRowFocusPin: (cellId: string) => void
  /** AQU-669: called when focus leaves this row — clears the owner if still ours. */
  onRowFocusRelease: (cellId: string) => void
  /** AQU-913: called when focus leaves this row — dismisses this cell's AI errors. */
  onClearCellErrors?: (cellId: string) => void
  onActivateEditor: ActivateEditor
  getEditorActivationVersion: () => number
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
  /** AQU-1146: per-cell slice of the table's `examples` map, resolved by the
   *  parent so this row's props are scalars — the map's identity changes on
   *  every batch commit, and a `Map` prop would defeat `React.memo` on every
   *  row even when only one cell's entry changed. Same reasoning for
   *  `completingState`, `cellError`, and `previewText` below. */
  cellExamples: ScoredPair[]
  completingState?: string
  cellError?: string
  previewText?: string
  healthRibbonPoint: HealthRibbonPoint
  infractions: Map<string, RuleInfraction[]>
  ruleMap: Map<string, TranslationRule>
  // AQU-670: resolves whether the draft actually committed — the rail's
  // "Saved" confirmation reads it (matches the top-level props contract).
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<boolean>
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
  /** p1-paragraph-ui-wiring (coordinator follow-up): true while ANY cell in
   *  this row's paragraph group is actively completing. AQU-1146: resolved
   *  by the parent (from the `completing` map and the group's member ids) so
   *  this row's prop is a stable scalar instead of the whole map. */
  paragraphGroupInFlight: boolean
  isBacktranslationConfigured?: boolean
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  getStatisticalBt?: (translatedText: string) => string
  getFootnoteDetails: (cellId: string) => CellFootnoteDetails
  cellOpenCommentCount?: Map<string, number>
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
  gridCols: EditorGridCols
  castGutter: boolean
  ttsSettings?: ProjectTtsSettings
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  /** Add-from-selection: create a terminology entry from selected source text. */
  onAddConceptFromSelection?: (draft: ConceptDraft) => void | Promise<void>
  addConceptBlockedReason?: string | null
  /** May this user APPROVE a term (enforce it), vs only suggest one? */
  canApproveConcept?: boolean
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
  /** FRO-317: when true, USFM \f...\f* footnotes render below each cell. */
  showFootnotesInline?: boolean
  /** True when inline/tray footnote detail is already visible elsewhere. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** When approved target renderings receive the subtle key-term highlight. */
  targetKeyTermHighlightMode?: TargetKeyTermHighlightMode
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
    cell, linkedTakes, cellExamples, completingState, cellError, previewText, healthRibbonPoint, infractions,
    backtranslating, backtranslationErrors, cellOpenCommentCount,
    rowIndex, contentNumber, gridCols, castGutter, ttsSettings,
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
    isRowFocused,
    onRowFocusPin,
    onRowFocusRelease,
    onClearCellErrors,
    onActivateEditor,
    getEditorActivationVersion,
    onDeactivateEditor,
    project, username, activeLane, editable, canValidate, canEditSource, sourceReadOnlyReason, isCompletionConfigured, isCompletionAvailable,
    ruleMap, onCompleteSingle, onCompleteParagraph, paragraphGroupSize,
    paragraphDraftableCount, paragraphGroupInFlight,
    isBacktranslationConfigured, onBacktranslate, onSaveBacktranslation, getStatisticalBt,
    getFootnoteDetails,
    onSeekToCue, lineNumbersEnabled, scriptureNumbering, cellLabelsEnabled,
    sourceDirectionMode, targetDirectionMode, sourceTextDirection, targetTextDirection, isAnonymous,
    onJumpToCell, micDenied, onProjectChanged, onAddConceptFromSelection, addConceptBlockedReason, canApproveConcept, onAskAiFromSelection, onAssignVoice,
    audioLens, onOpenAudioSetup,
    onCellCommitted, getPendingTargetEventId, onOptimisticEdit, lockHolderLabel, presenceStore, remoteChangedWhileFocused,
    onClaimCell, onReleaseCell, onTargetPresenceSelection, onAckRemoteChange,
    isStaleSource,
    isUpstreamStaleSource,
    showFootnotesInline,
    footnotePanelActive,
    footnoteViewMode = "off",
    targetKeyTermHighlightMode = "never",
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
  const highlights = useMemo(() => buildHighlightsFromExamples(cellExamples), [cellExamples])
  const cellInfractions = useMemo(() => infractions.get(cellId) ?? EMPTY_INFRACTIONS, [infractions, cellId])

  const { active: activeInfractions, waived: waivedInfractions } = useMemo(
    () => partitionInfractions(cellInfractions, cell.waivers),
    [cellInfractions, cell.waivers],
  )

  const isLoading = completingState === "searching" || completingState === "generating"
  // p1-paragraph-ui-wiring (coordinator follow-up): `paragraphGroupInFlight`
  // is true while ANY cell in this row's paragraph group is ACTIVELY
  // completing — not just this row's own (a validated start cell never gets
  // one post-skip, so relying on `isLoading` alone would let a second click
  // re-fire completeParagraph mid-fan-out). AQU-1146: resolved by the parent
  // from the full `completing` map + the group's member ids, and handed to
  // this row as a stable boolean prop (see `MemoizedRowProps`).
  // Streaming preview text — populated chunk-by-chunk by useCompletion's
  // onChunk handler. We surface it in the target column so the user sees
  // tokens arrive in real time instead of waiting for the LLM to finish
  // AND the commit-to-outbox chain to land (which adds a network hop).
  const completionPreview = previewText
  const loadingPhase: "searching" | "generating" | null =
    completingState === "searching"
      ? "searching"
      : completingState === "generating"
        ? "generating"
        : null
  const error = cellError
  const isBacktranslating = backtranslating?.has(cellId)
  const backtranslationError = backtranslationErrors?.get(cellId)
  const openCommentCount = cellOpenCommentCount?.get(cellId) ?? 0

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
        linkedTakes={linkedTakes}
        isEditorActive={isEditorActive}
        isRowFocused={isRowFocused}
        onRowFocusPin={onRowFocusPin}
        onRowFocusRelease={onRowFocusRelease}
        onClearCellErrors={onClearCellErrors}
        onActivateEditor={onActivateEditor}
        getEditorActivationVersion={getEditorActivationVersion}
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
        healthRibbonPoint={healthRibbonPoint}
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
        castGutter={castGutter}
        ttsSettings={ttsSettings}
        isAnonymous={isAnonymous}
        onJumpToCell={onJumpToCell}
        micDenied={micDenied}
        audioLens={audioLens}
        onOpenAudioSetup={onOpenAudioSetup}
        onProjectChanged={onProjectChanged}
        onAddConceptFromSelection={onAddConceptFromSelection}
        addConceptBlockedReason={addConceptBlockedReason}
        canApproveConcept={canApproveConcept}
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
        showFootnotesInline={showFootnotesInline}
        footnotePanelActive={footnotePanelActive}
        footnoteViewMode={footnoteViewMode}
        targetKeyTermHighlightMode={targetKeyTermHighlightMode}
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
  /** The heard lines performing this row that hold a recording, in film order
   *  — see `linkedTakesByCell` on the table's props. */
  linkedTakes?: LinkedTake[]
  isEditorActive: boolean
  /** AQU-669: this row is the single exclusive focus-pin owner. */
  isRowFocused: boolean
  /** AQU-669: report focus entering / leaving this row to the exclusive owner. */
  onRowFocusPin: (cellId: string) => void
  onRowFocusRelease: (cellId: string) => void
  /** AQU-913: dismiss this cell's inline AI errors when focus leaves the row. */
  onClearCellErrors?: (cellId: string) => void
  onActivateEditor: ActivateEditor
  getEditorActivationVersion: () => number
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
  healthRibbonPoint: HealthRibbonPoint
  cellInfractions: RuleInfraction[]
  waivedInfractions: RuleInfraction[]
  ruleMap: Map<string, TranslationRule>
  // AQU-670: resolves whether the draft actually committed — see above.
  onCompleteSingle: (cell: CellData, opts?: { regenerate?: boolean }) => void | Promise<boolean>
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
  gridCols: EditorGridCols
  castGutter: boolean
  ttsSettings?: ProjectTtsSettings
  isAnonymous?: boolean
  onJumpToCell?: (cellId: string) => void
  micDenied?: boolean
  audioLens: AudioLensContext | null
  onOpenAudioSetup?: () => void
  onProjectChanged?: () => void
  /** Add-from-selection: create a terminology entry from selected source text. */
  onAddConceptFromSelection?: (draft: ConceptDraft) => void | Promise<void>
  addConceptBlockedReason?: string | null
  /** May this user APPROVE a term (enforce it), vs only suggest one? */
  canApproveConcept?: boolean
  onAskAiFromSelection?: (chip: ContextChip) => void
  onAssignVoice?: (cellId: string, voiceId: string) => void
  getTokenForFile?: (fileId: string) => Promise<string | null>
  /** FRO-251: per-file source-column font size in px. Defaults to 14 when absent. */
  sourceFontSize?: number
  /** FRO-251: per-file target-column font size in px. Defaults to 14 when absent. */
  targetFontSize?: number
  /** FRO-317: when true, USFM \f...\f* footnotes render below the cell row. */
  showFootnotesInline?: boolean
  /** True when inline/tray footnote detail is already visible elsewhere. */
  footnotePanelActive?: boolean
  /** Current footnote display preference. */
  footnoteViewMode?: FootnoteViewMode
  /** When approved target renderings receive the subtle key-term highlight. */
  targetKeyTermHighlightMode?: TargetKeyTermHighlightMode
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
  onViewConcept?: (conceptId: string) => void
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
  onViewConcept,
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
          onViewConcept={onViewConcept}
        >
          <span className="terminology-highlight">
            <HighlightedText
              text={word}
              highlights={EMPTY_HIGHLIGHTS}
              ranges={clipRangesToTextSlice(ranges, start, end)}
              showEvidence={false}
              onRangeClick={onRangeClick}
            />
          </span>
        </TermLookupPopover>,
      )
    } else {
      parts.push(
        <HighlightedText
          key={`w-${i}`}
          text={word}
          highlights={EMPTY_HIGHLIGHTS}
          ranges={clipRangesToTextSlice(ranges, start, end)}
          showEvidence={false}
          onRangeClick={onRangeClick}
        />,
      )
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


function humanFootnoteCellRef(cell: CellData): string {
  const value = (cell.group || cell.context || "").trim()
  if (!value || looksLikeUuid(value)) return ""
  return value
}

function footnoteMarkerOptions(
  targetText: string,
  anchor: FootnoteInsertionAnchor | null,
  numberOffset: number,
  /** Passed in because this is a plain function and `t` is a hook; the option's
   *  `label`/`description` are rendered by AddFootnoteDialog. */
  t: TFunction,
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
      label: t("editor.footnote.markerNumbered"),
      caller: "+",
      startCaller: "1",
      preview: String(numberedPreview),
      startPreview: "1",
      description: t("editor.footnote.markerNumberedDesc"),
    },
    lettered: {
      label: t("editor.footnote.markerLettered"),
      caller: nextLetter,
      startCaller: "a",
      preview: nextLetter,
      startPreview: "a",
      description: t("editor.footnote.markerLetteredDesc"),
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

function TargetReadText({
  text,
  ranges,
  concepts,
  onRangeClick,
  onTermChipClick,
  footnotePanelActive,
  footnoteNumberOffset = 0,
  showKeyTermHighlights = false,
}: {
  text: string
  ranges: RangeHighlight[]
  concepts: Concept[]
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
  onTermChipClick?: (term: string, anchor: HTMLElement) => void
  footnotePanelActive?: boolean
  footnoteNumberOffset?: number
  showKeyTermHighlights?: boolean
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
        showKeyTermHighlights={showKeyTermHighlights}
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
        showKeyTermHighlights={showKeyTermHighlights}
      />,
    )
  })

  return <div>{parts}</div>
}

export function TargetDecoratedText({
  text,
  concepts,
  ranges,
  onRangeClick,
  onTermChipClick,
  showKeyTermHighlights = false,
}: {
  text: string
  concepts: Concept[]
  ranges: RangeHighlight[]
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
  onTermChipClick?: (term: string, anchor: HTMLElement) => void
  showKeyTermHighlights?: boolean
}) {
  const t = useT()
  const matches = useMemo(() => {
    const activeConcepts = concepts.filter((concept) => concept.status === "active")
    if (activeConcepts.length === 0 || !text) return []

    const out: Array<{ start: number; end: number; term: string }> = []
    for (const concept of activeConcepts) {
      const approvedRenderings = concept.renderings.filter(
        (rendering) => rendering.status === "preferred" || rendering.status === "admitted",
      )
      for (const rendering of approvedRenderings) {
        for (const match of findTermMatches(text, rendering.rendering)) {
          out.push({ ...match, term: concept.sourceTerm })
        }
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
      <AppTooltip key={`t-${index}-term`} content={t("editor.term.managed", { term: match.term })}>
        <span
          role={onTermChipClick ? "button" : undefined}
          tabIndex={onTermChipClick ? 0 : undefined}
          aria-label={t("editor.term.managed", { term: match.term })}
          className={cn(
            "term-chip-host",
            showKeyTermHighlights && "terminology-highlight",
          )}
          data-source-term={match.term}
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
        >
          <HighlightedText
            text={matchedText}
            highlights={EMPTY_HIGHLIGHTS}
            ranges={clipRangesToTextSlice(ranges, match.start, match.end)}
            showEvidence={false}
            onRangeClick={onRangeClick}
          />
        </span>
      </AppTooltip>,
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
          <AppTooltip key={i} content={att.title ?? undefined} disabled={!att.title}>
            <video
              src={att.url}
              controls
              className="max-h-32 rounded border object-contain"
            />
          </AppTooltip>
        ) : (
          <AppTooltip key={i} content={att.title ?? undefined} disabled={!att.title}>
            <img
              src={att.url}
              alt={att.alt}
              loading="lazy"
              className="block max-h-32 rounded border object-contain"
            />
          </AppTooltip>
        ),
      )}
    </div>
  )
}

function EditorRow({
  project, cell, linkedTakes, isEditorActive, isRowFocused, onRowFocusPin, onRowFocusRelease, onClearCellErrors, onActivateEditor, getEditorActivationVersion, onDeactivateEditor,
  username, activeLane = "", editable, canValidate, canEditSource, sourceReadOnlyReason, isCompletionConfigured, isCompletionAvailable, isLoading,
  completionPreview, loadingPhase,
  cellExamples, highlights, error, healthRibbonPoint,
  cellInfractions, waivedInfractions, ruleMap,
  onCompleteSingle,
  onCompleteParagraph, paragraphGroupSize, paragraphDraftableCount, paragraphGroupInFlight,
  isBacktranslationConfigured, isBacktranslating, backtranslationError, onBacktranslate, onSaveBacktranslation,
  getStatisticalBt,
  getFootnoteDetails,
  openCommentCount,
  onSeekToCue,
  onDragStart, onDragEnter, onSelectionPointerDown, onNavigateCell,
  onEscapeToGrid, onGridRowKeyNav,
  rowIndex, contentNumber, lineNumbersEnabled, scriptureNumbering, cellLabelsEnabled, sourceDirectionMode, targetDirectionMode, sourceTextDirection, targetTextDirection, gridCols, castGutter, ttsSettings,
  isAnonymous, micDenied,
  audioLens, onOpenAudioSetup, onAssignVoice, onAddConceptFromSelection, addConceptBlockedReason, canApproveConcept, onAskAiFromSelection,
  onCellCommitted, getPendingTargetEventId, onOptimisticEdit, lockHolderLabel, presenceStore, remoteChangedWhileFocused,
  onClaimCell, onReleaseCell, onTargetPresenceSelection, onAckRemoteChange,
  isStaleSource,
  isUpstreamStaleSource,
  getAlignmentModel,
  onAlignmentSeedChange,
  sourceFontSize = 14,
  targetFontSize = 14,
  showFootnotesInline,
  footnotePanelActive,
  footnoteViewMode = "off",
  targetKeyTermHighlightMode = "never",
  onFootnoteHoverChange,
  onFootnoteCreated,
  sourceFootnoteNumberOffset,
  targetFootnoteNumberOffset,
}: EditorRowProps) {
  const t = useT()
  const healthCalculationsEnabled = useHealthCalculationsEnabled()
  // FRO perf cleanup: pure pass-through openers (never consumed by
  // EditorTable/MemoizedRow) come from context instead of the prop chain —
  // keeps them out of MemoizedRow's React.memo compare surface.
  const {
    onInfractionClick, onOpenComments, onOpenHistory, onOpenTerminologyConcept,
    onAiSetupNeeded, onOpenRecording,
    onMediaRowActivate, onAssignCastVoice, onClearCastVoice, onTakeSaved, audioHomeFor, myScopes,
  } = useEditorActions()
  // AQU-633: a scoped member can only validate cells in their assigned lane/file.
  // Combine the role capability with the per-cell scope check so an out-of-scope
  // cell greys the toggle instead of offering a guaranteed-403 validate. Unscoped
  // members (empty scopes) → always in scope, so this is a no-op for them.
  const canValidateThisCell = canValidate && isInMemberScope(myScopes, cell.fileId, activeLane)
  // 2026-08-07: the timeline's pointed-at cell (media lens only — the store
  // self-clears when the timeline unmounts). Per-row subscription so a cursor
  // move re-renders exactly the two affected rows.
  const isMediaCursorRow = useIsMediaCursorCell(cell.id)
  // Wire c: the cell the queue is RUNNING right now (stacked lens only —
  // gated on the same media-sync flag so bar-driven playback in the Text
  // lens keeps its existing scroll-and-flash behavior unchanged). Both hooks
  // run unconditionally; only the combination is conditional.
  const isQueueCurrentCell = useIsQueueCurrentCell(cell.id)
  // Round 5: the same "either transport" rule the follow driver uses — without
  // it the sounding row went unmarked on a file the picture is driving.
  const videoSoundingCellId = useVideoSoundingCellId()
  const rowMediaSyncActive = useMediaSyncActive()
  const isQueueRow = (isQueueCurrentCell || videoSoundingCellId === cell.id) && rowMediaSyncActive
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
  // AQU-1154 (invariant I4: an overlay never replaces newer text with older).
  // A peer's live draft is newer than this row's projection while they are in
  // the cell, and it STAYS newer after they leave until their commit lands
  // here — on a slow link that is seconds later. Snapping back to the row on
  // blur showed the pre-edit text. So: an empty live draft never renders (the
  // row wins), and the last non-empty draft is held after the peer leaves
  // until this row's own text changes or a bounded timeout elapses.
  const liveRemoteDraft = remoteDraftText || undefined
  const [heldRemoteDraft, setHeldRemoteDraft] = useState<{
    text: string
    targetEventIdAtStart: string | null
    translatedAtStart: string | null
  } | null>(null)
  useEffect(() => {
    const targetEventId = cell.targetEventId ?? null
    const translated = cell.translated ?? null
    setHeldRemoteDraft((cur) => {
      const rowChanged = cur !== null
        && (cur.targetEventIdAtStart !== targetEventId || cur.translatedAtStart !== translated)
      const base = rowChanged ? null : cur
      if (liveRemoteDraft === undefined) return base
      if (base && base.text === liveRemoteDraft) return base
      return {
        text: liveRemoteDraft,
        targetEventIdAtStart: base?.targetEventIdAtStart ?? targetEventId,
        translatedAtStart: base?.translatedAtStart ?? translated,
      }
    })
  }, [liveRemoteDraft, cell.targetEventId, cell.translated])
  const holdingRemoteDraft = liveRemoteDraft === undefined && heldRemoteDraft !== null
  useEffect(() => {
    if (!holdingRemoteDraft) return
    const timer = setTimeout(() => setHeldRemoteDraft(null), REMOTE_DRAFT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [holdingRemoteDraft])
  const overlayDraftText = liveRemoteDraft ?? heldRemoteDraft?.text
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  // AQU-664: hover ("wave over") a violation blot → preview its rule
  // explanation. Separate from the click path (openRuleId) so a light,
  // non-interactive popover appears on hover and dismisses on mouse-out.
  const [hoveredRule, setHoveredRule] = useState<{
    ruleId: string
    anchor: { getBoundingClientRect: () => DOMRect }
  } | null>(null)
  // AQU-664: live editor text, published on a short debounce by TranslatedEditor
  // so terminology blots recompute off the live buffer (not the ~1.2s commit).
  const [liveTargetText, setLiveTargetText] = useState<string | null>(null)
  const examplesExpanded = false
  // FRO-204: chip click state for TermLookupPopover on target editor chips.
  const [termChipState, setTermChipState] = useState<{ term: string; anchor: HTMLElement } | null>(null)
  // Add-from-selection (Slice 5): the source-side text the user has selected,
  // surfaced as an "Add to terminology" affordance. Null when nothing selected.
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
  const [addTermOpen, setAddTermOpen] = useState(false)
  const pendingTargetEventIdRef = useRef<string | null>(cell.targetEventId ?? null)
  /** Id of the last target.cell.commit this row enqueued (null until one is). */
  const lastCommittedEventIdRef = useRef<string | null>(null)
  // Source-edit affordance (project_lead+ on non-live projects). Editing the
  // SOURCE lane emits source.cell.commit — the template-owner correction that
  // propagates to downstream linked projects. `sourceDraft` is a LOCAL optimistic
  // hold of the just-committed text (kept out of the target-only optimistic-shadow
  // machinery in useCells) shown until the projection round-trips.
  const [sourceEditing, setSourceEditing] = useState(false)
  const [sourceDraft, setSourceDraft] = useState<{ value: string; valueHtml: string } | null>(null)
  // AQU-646: a media cell's editable source text is its TRANSCRIPTION. The
  // stored value is the import FILENAME — an import record, not prose — so for
  // these cells the editor opens on the transcript (blank when untranscribed,
  // never the filename) and commits land on `transcription`, leaving the
  // filename intact. Before this, editing surfaced the filename and saving it
  // replaced the transcript on screen permanently.
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
  // FRO-237: mic-denied help popover state — the rail button stays ENABLED
  // when mic is blocked and routes click here. Portaled so the cell's
  // overflow clip cannot hide it.
  const [showMicDeniedHelp, setShowMicDeniedHelp] = useState(false)
  const micHelpAnchorRef = useRef<HTMLDivElement>(null)
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
  const pendingIdmlPointerSelectionRef = useRef<IdmlPointerSelection | null>(null)
  // AQU-746: activation is async (read view → TipTap mount → rAF focus), so a
  // printable keydown typed in that window has no focused editor to land in and
  // is silently dropped. Buffer those keys on the (synchronously refocused) row
  // wrapper and replay them once the editor reports focus, so a fast typist
  // never loses the first character(s). See requestTargetEdit / handleGridRowKeyDown.
  const awaitingEditorFocusRef = useRef(false)
  const pendingActivationInputRef = useRef<string>("")
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
  // AQU-646 stage 3f: where this row's audio belongs — itself on every ordinary
  // file, the heard lines performing it on a file with an audio-cue sibling, and
  // NULL when a cue sibling exists but nothing performs this line. Read from
  // context rather than a prop on purpose: MemoizedRow forwards row props one
  // by one, so a new prop here is four edits and a silent omission away.
  const audioHomes = audioHomeFor ? audioHomeFor(cell) : [cell]
  /** The one the voice button plays and replays from. The rest are written too
   *  (Sam, 2026-08-25: nothing is left silent) but only one can be heard. */
  const audioHome = audioHomes?.[0] ?? null
  const visibleTranslated = localTargetDraft?.value ?? cell.translated
  const visibleTranslatedHtml = localTargetDraft?.valueHtml ?? cell.translatedHtml
  const idmlConfiguration = useMemo(
    () => resolveIdmlEditorConfiguration(cell.metadata, cell.originalHtml),
    [cell.metadata, cell.originalHtml],
  )
  const idmlStyleCatalog = idmlConfiguration?.kind === "ready"
    ? idmlConfiguration.context.styleCatalog
    : undefined
  const idmlParagraphStyleId = idmlConfiguration?.kind === "ready"
    ? idmlConfiguration.context.paragraphStyleId
    : undefined
  const canEditSourceForCell = canEditSource && !idmlConfiguration
  // AQU-847: an imported MEDIA section's `value` (→ `cell.original`) is the
  // import FILENAME; its real source text is the transcript. The read surface
  // already knew that (filename only as a placeholder before transcription) —
  // the EDIT surface didn't, so opening the pencil loaded the filename and
  // committing it overwrote the transcript with the file's title. The four
  // `cell-text` helpers below carry that rule across seed/commit/display/
  // reconcile so the two surfaces can't drift apart again.
  const sourceSeed = sourceEditorSeed(cell)
  const sourceReadOnlyReasonForCell = idmlConfiguration
    ? t("editor.source.idmlProtected")
    : sourceReadOnlyReason
  const hasTranslatedText = Boolean(visibleTranslated?.trim())
  const showCompletionOverlay = isLoading && !hasTranslatedText
  const sourceCellDirection = useMemo(
    () =>
      resolveTextDirection(
        sourceDirectionMode,
        // Media cells read direction off the TRANSCRIPT — their stored value is
        // the import filename, whose Latin script would force LTR on an RTL
        // transcript.
        cell.medium === "media" && cell.transcription?.trim()
          ? cell.transcription
          : (cell.originalHtml ?? cell.original),
        sourceTextDirection,
      ),
    [sourceDirectionMode, sourceTextDirection, cell.originalHtml, cell.original, cell.medium, cell.transcription],
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
  const showTargetKeyTermHighlights =
    targetKeyTermHighlightMode === "always" ||
    (targetKeyTermHighlightMode === "focused" && isRowFocused)

  useEffect(() => {
    if (!localTargetDraft) return
    // Normal case: the authoritative value now carries our just-committed draft
    // (server projection or optimistic echo) — drop the local hold.
    if ((cell.translated ?? "") === localTargetDraft.value) {
      setLocalTargetDraft(null)
      return
    }
    // AQU-667 masking fix: an authoritative AI draft (sparkle / batch) landed
    // whose value differs from our stale local hold. Previously the hold was
    // only cleared on exact equality, so if a human edit's round-trip hadn't
    // landed when the prediction arrived the values never converged: the row
    // kept showing the OLD text indefinitely and a later keystroke committed
    // that old text over the AI draft. The AI draft is the newer truth — clear
    // the hold so the row (and the editor hydrating from it) shows the prediction.
    if (cell.aiDrafted) {
      setLocalTargetDraft(null)
    }
  }, [cell.translated, cell.aiDrafted, localTargetDraft])

  useEffect(() => {
    if (cell.targetEventId) pendingTargetEventIdRef.current = cell.targetEventId
  }, [cell.targetEventId])

  // AQU-1154 (I2/I4): the local hold above only clears on exact value match.
  // If the projected head moves to an event this row did NOT commit, our
  // commit either lost the head compare-and-swap or was superseded — either
  // way the server row is the newer truth, so drop the hold instead of
  // painting the losing text forever. Declared after the pendingTargetEventId
  // sync so the id we committed is read from its own ref, not that one.
  useEffect(() => {
    if (!localTargetDraft) return
    const head = cell.targetEventId
    const committed = lastCommittedEventIdRef.current
    if (head && committed && head !== committed) {
      setLocalTargetDraft(null)
    }
  }, [cell.targetEventId, localTargetDraft])

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

  // AQU-664: terminology-only rules, extracted from the shared ruleMap. Used to
  // recompute term violations off the live editor buffer so the inline blot
  // lights up as-you-type instead of after the ~1.2s commit-idle debounce.
  const enabledTermRules = useMemo(() => selectTermRules(ruleMap.values()), [ruleMap])

  // Live terminology infractions computed from the un-committed buffer. Only
  // active while this cell is being edited and a live snapshot has arrived;
  // otherwise null so the committed (health-derived) infractions are used.
  const liveTermInfractions = useMemo<RuleInfraction[] | null>(() => {
    if (!isEditorActive || liveTargetText === null) return null
    return computeLiveTermInfractions(cell, liveTargetText, enabledTermRules)
  }, [isEditorActive, liveTargetText, enabledTermRules, cell])

  // Infractions that drive the inline blot decorations. While editing, the
  // committed `term:` infractions (which lag by a commit cycle) are replaced by
  // the live ones so the terminology blot tracks the buffer; non-terminology
  // infractions keep the committed cadence.
  const blotInfractions = useMemo(
    () =>
      liveTermInfractions === null
        ? mergedInfractions
        : mergeBlotInfractions(mergedInfractions, liveTermInfractions),
    [mergedInfractions, liveTermInfractions],
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
  const handleEditorCommit = useCallback(async ({ value, valueHtml }: { value: string; valueHtml: string }): Promise<boolean> => {
    if (!editable) return false
    if (!project.id) return false
    // FRO-273: belt-and-suspenders role-mirror check. `editable` is already
    // false for roles < CONTRIBUTOR, so this guard only fires in the unlikely
    // race where `editable` hasn't updated yet after a role downgrade — it
    // prevents a guaranteed-403 event from entering the durable outbox.
    if (!canPerform("target.cell.commit", project.syncRole?.level ?? null)) {
      console.warn("[editor-commit] aborting: role too low for target.cell.commit")
      return false
    }
    // AQU-1154: the focus lock is advisory — it drives the read-only affordance
    // and the "X is editing" label, never the write path. This used to abort
    // the commit when presence said someone else held the cell, which silently
    // threw away the user's text: a socket flap drops our lease server-side,
    // the reconnect did not re-claim, a peer claimed, and our next idle/blur
    // commit vanished with only a console.warn while our editor still showed
    // it. The server head-check is the real arbiter; the commit always
    // proceeds to the outbox and any loss surfaces through stale handling.
    const idmlCommitError = validateIdmlEditorCommit(idmlConfiguration, valueHtml)
    if (idmlCommitError) {
      setWriteError(idmlCommitError)
      return false
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
    // survives Legend List row remounts and is the one the workspace CLEARS
    // when the server reports that pending commit stale (AQU-1154), so when
    // it is wired the row-local ref must not be consulted — it would re-chain
    // on the losing id. The row-local ref only covers hosts without a
    // workspace getter.
    const parentId =
      (getPendingTargetEventId
        ? getPendingTargetEventId(cell.id)
        : pendingTargetEventIdRef.current) ??
      cell.targetEventId ??
      cell.sourceEventId ??
      null
    // AQU-538: tag the commit with the active lane. The store now renders this
    // row's ACTIVE-lane target value, so the edited text belongs to `activeLane`.
    // emitTargetCellCommit omits `''` (default lane) on the wire, so N=1 is
    // byte-identical.
    try {
      const eventId = await emitTargetCellCommit({
        projectId: project.id,
        fileId: cell.fileId,
        cellId: cell.id,
        parentId,
        sourceEventId: cell.sourceEventId ?? null,
        value,
        valueHtml,
        author: username,
        targetLang: activeLane,
      })
      pendingTargetEventIdRef.current = eventId
      lastCommittedEventIdRef.current = eventId
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
      return true
    } catch (err) {
      // RES-4/M1-3: enqueue failure (IDB quota, private-mode, InsufficientRoleError)
      // must be loud. Revert the optimistic patch so the cell doesn't show
      // "saved" styling for an event that exists nowhere durable.
      console.error("[editor-commit] enqueue failed:", err)
      const msg = err instanceof Error ? err.message : t("editor.write.saveFailed")
      setWriteError(msg)
      setLocalTargetDraft(null)
      // Revert the optimistic patch to the last confirmed projection value.
      onOptimisticEdit?.(cell.id, {
        value: cell.translated ?? "",
        valueHtml: cell.translatedHtml ?? "",
      })
      return false
    }
  }, [editable, canValidate, project.id, project.syncRole?.level, project.allowSelfValidation, cell.fileId, cell.id, cell.targetEventId, cell.translated, cell.translatedHtml, cell.sourceEventId, username, activeLane, onCellCommitted, getPendingTargetEventId, onOptimisticEdit, idmlConfiguration, t])

  // AQU-618: run a single-cell AI generate/Replace, then return the translator
  // to the edited cell and confirm the save. Both entry points — the Replace
  // confirm dialog and the direct sparkle on an empty cell — used to fire
  // `onCompleteSingle` and leave focus on the dialog / rail button with no
  // saved signal, so testers re-applied the change unsure it had persisted.
  // We await the commit (completeSingle auto-commits and flushes the outbox),
  // then re-focus the cell editor only if the translator has not activated or
  // focused another cell meanwhile. The saved signal is independent of focus:
  // the originating row still confirms that its write landed.
  const completeSingleAndReturn = useCallback(async () => {
    const activationVersion = getEditorActivationVersion()
    const saved = await onCompleteSingle(cell)
    onActivateEditor(cell.id, { ifActivationVersion: activationVersion })
    // AQU-670: only confirm "Saved" when the draft actually committed. On a
    // failed enqueue completeSingle resolves `false` and records the error
    // (shown inline via the `error` line); showing "Saved" as well would give
    // the translator directly contradictory signals for a draft that was lost.
    if (!saved) return
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setShowSaved(true)
    savedTimerRef.current = setTimeout(() => {
      setShowSaved(false)
      savedTimerRef.current = null
    }, 2400)
  }, [onCompleteSingle, cell, onActivateEditor, getEditorActivationVersion])

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
    if (!canEditSourceForCell || !project.id) return
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
      // AQU-847: on a media section this routes the typed text to
      // `transcription` and resends the filename `value` unchanged.
      ...sourceCommitFields(cell, { value, valueHtml }),
      author: username,
    }).then((eventId) => {
      pendingSourceCommitRef.current = { eventId, parentId }
      void onCellCommitted?.(cell.id)
    }).catch((err) => {
      console.error("[source-edit] enqueue failed:", err)
      const msg = err instanceof Error ? err.message : t("editor.write.saveSourceFailed")
      setWriteError(msg)
      setSourceDraft(null)
    })
  }, [canEditSourceForCell, project.id, project.syncRole?.level, cell, username, onCellCommitted, t])

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
  // AQU-847: a media section's edit lands on `transcription`, not `original`,
  // so reconcile against whichever field this cell's edit actually writes —
  // otherwise the draft never clears and the row stays on optimistic text.
  useEffect(() => {
    if (sourceDraft && projectedSourceValue(cell) === sourceDraft.value) setSourceDraft(null)
  }, [cell, sourceDraft])

  // Force-close an OPEN source editor when canEditSource flips false mid-edit
  // (e.g. a settings revalidate delivers a DCS cursor). Without this the editor
  // stayed mounted but handleSourceCommit's guard silently dropped every commit
  // — the user kept typing into a void. Closing is bounded loss (only the text
  // since the flip moment); the writeError banner says WHY so it isn't silent.
  useEffect(() => {
    if (!sourceEditing || canEditSourceForCell) return
    setSourceEditing(false)
    setWriteError(
      sourceReadOnlyReasonForCell ?? t("editor.write.sourceEditingClosed"),
    )
  }, [sourceEditing, canEditSourceForCell, sourceReadOnlyReasonForCell, t])

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

  const captureFootnoteAnchor = useCallback(() => {
    pendingFootnoteAnchorRef.current = translatedEditorRef.current?.getFootnoteInsertionAnchor() ?? null
  }, [])

  const openAddFootnoteDialog = useCallback((defaults?: AddFootnoteDialogDefaults) => {
    if (!pendingFootnoteAnchorRef.current) captureFootnoteAnchor()
    const anchor = pendingFootnoteAnchorRef.current
    const markerOptions = footnoteMarkerOptions(visibleTranslated ?? "", anchor, targetFootnoteNumberOffset, t)
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
  }, [captureFootnoteAnchor, cell, visibleTranslated, targetFootnoteNumberOffset, t])

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

  // Add-from-selection: capture a source-side text selection so the
  // translator can add it to terminology without leaving the editor.
  const handleSourceMouseUp = useCallback(() => {
    if (!onAddConceptFromSelection && !onAskAiFromSelection) return
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : ""
    // A collapsed mouseup must not wipe a prior capture. The add-term popover
    // lives inside this source cell, so its mouseup bubbles here after focus
    // has already collapsed the browser selection (AQU-1006 / AQU-260).
    if (!text) return
    capturedSelectionRef.current = text
    setSourceSelection(text)
  }, [onAddConceptFromSelection, onAskAiFromSelection])

  const handleAddTermOpenChange = useCallback((open: boolean) => {
    if (open) {
      const text = capturedSelectionRef.current
      if (text) setSourceSelection(text)
    }
    setAddTermOpen(open)
  }, [])

  const handleCreateTerm = useCallback((draft: ConceptDraft) => {
    capturedSelectionRef.current = null
    setSourceSelection(null)
    setAddTermOpen(false)
    window.getSelection()?.removeAllRanges()
    void onAddConceptFromSelection?.(draft)
  }, [onAddConceptFromSelection])

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
  // "Add to terminology" toolbar from floating over a different row's content.
  // FRO-260: guard — do NOT clear when the user is pressing down on a toolbar
  // button (toolbarMouseDownRef=true). The selectionchange fires before onClick
  // in the mousedown-click sequence; clearing here would make onClick see null.
  useEffect(() => {
    if (!sourceSelection) return
    // While the add-term popover is open it owns the captured term — focusing
    // an input collapses the browser selection, and clearing sourceSelection
    // here would unmount the toolbar (and the popover) mid-edit.
    if (addTermOpen) return
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
  }, [sourceSelection, addTermOpen])

  // FRO-204: Chip click handler for terminology chips in the target.
  const handleTermChipClick = useCallback((term: string, anchor: HTMLElement) => {
    setTermChipState({ term, anchor })
  }, [])

  const emitValidationChange = useCallback(async (validated: boolean) => {
    // FRO-273: role-mirror guard — viewer/commenter should never reach here
    // (canValidate=false disables the button) but guard defensively so a
    // guaranteed-403 never enters the outbox.
    if (!canPerform(validated ? "cell.validate" : "cell.unvalidate", project.syncRole?.level ?? null)) {
      console.warn("[validate] aborting: role too low for", validated ? "cell.validate" : "cell.unvalidate")
      return false
    }
    // AQU-633: additive lane/file scope guard. A scoped member's validate on an
    // out-of-scope cell is a guaranteed 403 — don't optimistically flip then
    // revert. The toggle is already greyed (canValidateThisCell); this covers
    // keyboard/programmatic triggers too. Unscoped members are always in scope.
    if (!isInMemberScope(myScopes, cell.fileId, activeLane)) {
      console.warn("[validate] aborting: cell out of the caller's assigned scope")
      return false
    }
    // AQU-646: `getPendingTargetEventId` covers the take case. Recording emits an
    // empty target commit to create the row, and the projection has not come
    // back by the time the control appears — without this, validating a
    // just-recorded line would silently do nothing, which is the exact failure
    // the empty commit exists to prevent.
    const editEventId =
      cell.targetEventId ?? pendingTargetEventIdRef.current ?? getPendingTargetEventId?.(cell.id) ?? null
    if (!project.id || !editEventId) return false
    // AQU-538: scope the validation to the active lane. emitCellValidate/
    // emitCellUnvalidate omit `''` (default lane) on the wire, so N=1 is
    // byte-identical.
    const emit = validated ? emitCellValidate : emitCellUnvalidate
    try {
      await emit({
        projectId: project.id,
        fileId: cell.fileId,
        cellId: cell.id,
        editEventId,
        author: username,
        targetLang: activeLane,
      })
      await onCellCommitted?.(cell.id)
      return true
    } catch (err) {
      console.warn(`[${validated ? "validate" : "unvalidate"}] emit failed:`, err)
      // FRO-274: surface enqueue failure inline.
      setWriteError("Couldn't save this change locally — copy your text and reload.")
      return false
    }
  }, [cell.fileId, cell.id, cell.targetEventId, project.id, project.syncRole?.level, username, activeLane, myScopes, onCellCommitted, getPendingTargetEventId])

  const editorFocusedRef = useRef(false)
  const requestTargetEdit = useCallback((pointerSelection?: IdmlPointerSelection | null) => {
    if (!editable || isLoading || lockHolderLabel) return
    pendingIdmlPointerSelectionRef.current = pointerSelection ?? null
    // AQU-746: open the keystroke-buffer window and move focus to the persistent
    // row wrapper *synchronously*, before React swaps the read view out. Without
    // this the read view unmounts, focus falls to <body>, and any keydown before
    // the editor focuses is lost. On the row wrapper those keydowns are catchable
    // (handleGridRowKeyDown) and get replayed on editor focus.
    awaitingEditorFocusRef.current = true
    pendingActivationInputRef.current = ""
    rowRef.current?.focus({ preventScroll: true })
    onActivateEditor(cell.id)
  }, [editable, isLoading, lockHolderLabel, onActivateEditor, cell.id])

  const handleTargetPresenceSelection = useCallback((selection: TargetPresenceSelection | null) => {
    onTargetPresenceSelection?.(cell.id, selection)
  }, [cell.id, onTargetPresenceSelection])

  const handleEditorFocus = useCallback(() => {
    editorFocusedRef.current = true
    // AQU-746: the editor now owns the caret — stop buffering; TranslatedEditor
    // replays whatever was captured during activation (see its onFocus).
    awaitingEditorFocusRef.current = false
    onActivateEditor(cell.id)
    onClaimCell?.(cell.id)
    onAckRemoteChange?.(cell.id)
  }, [cell.id, onActivateEditor, onClaimCell, onAckRemoteChange])

  const handleEditorBlurOuter = useCallback(() => {
    // AQU-746: activation was abandoned without the editor ever focusing — drop
    // any buffered keys so they can't leak into a later, unrelated activation.
    awaitingEditorFocusRef.current = false
    pendingActivationInputRef.current = ""
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
        // See focusCellEditorByIndex: native caret-at-end breaks empty IDML slots.
        if (idmlConfiguration || pm.querySelector("[data-idml-version]")) return
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
  }, [isEditorActive, cell.id, idmlConfiguration, onReleaseCell])

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

  const healthValue = healthRibbonPoint.rawScore
  const smoothedHealthValue = healthRibbonPoint.smoothedScore

  // AQU-800: timeline-ordered cells carry a timecode range as their context
  // (e.g. "00:00:00.000 --> 00:00:03.970"). Left-align that line so the
  // timecodes sit above the left edge of the source text; other context
  // (scripture verse refs like "GEN 1:1", empty) stays centered. Reuse the
  // existing timestamp-range parser rather than inventing a second rule.
  const contextIsTimecode = Boolean(cell.context && parseTimestampRange(cell.context))

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
  // The transcribe / correct-transcript handlers moved into CellTakeBlock
  // (2026-08-22) so they can be scoped to whichever cell OWNS the recording —
  // a linked heard line's take must write to the cue sibling, not to this row.
  const { session: rowSession } = useFrontierSession()

  // AQU-646: a recorded take IS target content. A line added into a silence may
  // never get text — the dub is the deliverable — and it still has to be
  // validatable and countable. `resolveTargetAudio` is the take-aware test: it
  // matches a clip seeded with THIS cell's id, so the shared imported source
  // clip (seeded with the file's id) can never masquerade as somebody's work.
  // The row's `cell` already carries attachments via applyRowOverlays.
  const hasContent =
    Boolean(visibleTranslated && visibleTranslated.trim()) || Boolean(resolveTargetAudio(cell))

  // The automatic stage uses the smoothed server-derived estimate. Missing
  // evidence is unknown, not an endorsement-derived zero. Validation is a
  // separate authoritative stage and automatic rule issues stay visible.
  const decayConfig = useMemo(
    () => resolveDecayConfig(project.decaySettings, readValidationCount(project)),
    [project.decaySettings, project.validationCount],
  )
  const cellNeedsAttention = hasContent
    && healthRibbonPoint.stage === "automatic"
    && smoothedHealthValue !== undefined
    && needsAttentionFromConfidence(smoothedHealthValue, decayConfig.decayWarnThreshold)

  const hasMajorInfraction = cellInfractions.some(
    (i) => ruleMap.get(i.ruleId)?.severity === "major",
  )
  const infractionCount = cellInfractions.length


  // SECURITY: originalHtml below is sanitized at the render boundary by
  // sanitizeSourceDisplayHtml, which allowlists exactly the inline tags the
  // parsers produce (<b>, <i>, <u>, <s>, <code>). Anything else in an imported
  // document — notably <img>/<a>, which DOMPurify's defaults let through —
  // is dropped rather than rendered. See OPS-8.
  // Prefer the explicitly-assigned cast member's name; then the character the
  // cell itself names; then the cell's own label (e.g. a chapter/verse marker
  // from USFM), then nothing.
  //
  // AQU-1018: `ownCastName` is the middle rung, and it is what makes a freshly
  // imported subtitle row say who is speaking. The assigned-voice name only
  // resolves once `castAssignments` has landed AND the voice is still in the
  // library, and neither holds at the moment the client actually needs the
  // label: on import there are no targets yet to read the name off, the
  // character sheet's `cast.assign` events land BEFORE the `saveTts` that mints
  // the voices (a documented degraded-success window in
  // ProjectWorkspace.handleImportCharacters), and deleting a voice later strands
  // every assignment pointing at it. In all three the sheet's `cast_name` is
  // sitting right there on the cell — the cast gutter has always drawn it — and
  // the two corners went blank anyway.
  const castVoiceId = cellLabelsEnabled ? assignedCastVoiceId(project.ttsSettings, cell.id) : undefined
  const castName = castVoiceId ? findVoice(project.ttsSettings, castVoiceId)?.name : undefined
  const labelText = castName ?? ownCastName(cell) ?? cell.cellLabel ?? null
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
  // ── Character gutter (2026-08-07, stacked media lens only) ──────────────
  // A row "speaks" unless it's STRUCTURE (paratext/heading) — the same set
  // whose number pill is suppressed, so the two left-edge columns read
  // consistently. The voice resolves through the LIVE tts settings
  // (castAssignments → per-cell pin → default); "explicit" is gated through
  // findVoice so an assignment pointing at a DELETED voice truthfully renders
  // as the faded fallback rather than solid-but-narrator.
  //
  // AQU-646 round 8: the rule used to ALSO require source text, which is what
  // the comment above has always claimed the number pill does — and it does
  // not. Two rows lost their circle to that: a line someone just added into a
  // silence, which has no text yet by definition, and a transcribed media cell
  // whose stored `value` is the import filename. (Reaching for `??` there
  // never helped either: cell.original is decodeHtmlEntities(value ?? ""), so
  // it is always a string and never nullish, and cell.transcription was never
  // consulted.) The 40px gutter column is reserved unconditionally, so a
  // missing circle read as a missing CONTROL rather than a missing column.
  const gutterSpeaking =
    castGutter &&
    cell.type !== "paratext" &&
    cell.type !== "heading"
  const gutterVoice = gutterSpeaking
    ? resolveCastVoice(ttsSettings, cell.id, cell.ttsSettings?.voiceId)
    : null
  const gutterExplicit =
    gutterSpeaking &&
    Boolean(findVoice(ttsSettings, assignedCastVoiceId(ttsSettings, cell.id) ?? cell.ttsSettings?.voiceId))
  const gutterCastName =
    cell.metadata && typeof cell.metadata.cast_name === "string" ? (cell.metadata.cast_name as string) : null
  const gutterVoices = useMemo(() => getVoiceLibrary(ttsSettings), [ttsSettings])
  const gutterLanguageBadge = showVoiceLanguageBadge(projectTargetLaneLanguages(project))

  const numberPill = numberLabel === null ? null : (
    // Box the digit to the source's first line (fontSize × line-height 1.6,
    // both set on the source well below) and center it, so the number keeps
    // riding that line as the reader changes font size. A fixed height only
    // happens to line up at one size.
    <span
      className="flex items-center justify-center leading-none"
      style={{ height: `calc(${sourceFontSize}px * 1.6)` }}
      aria-label={t("editor.row.lineAria", { number: numberLabel })}
    >
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
  // AQU-669: focus-within is no longer per-row local state (which went stale
  // when a focus-out failed to fire and left the rail pinned forever). It's the
  // single exclusive owner threaded from the table: this row has focus iff it
  // is the `focusedRailCellId`. Focusing another cell overwrites that id and
  // deterministically un-pins this one.
  const hasFocusWithin = isRowFocused
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
  // sync-worker, not the cell projection, so the drawer fetches the Postgres
  // event log on demand — the row itself no longer renders a duplicate inline list.

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

  // ── BT tab: statistical gloss is computed while the tab is open so the
  // live "as you translate" check and AI-vs-pairs disagreement can render
  // without waiting on a collapsed expander.
  const statisticalGloss = useMemo(() => {
    if (!expanded || expansionTab !== "backtranslation" || !visibleTranslated.trim()) return ""
    return getStatisticalBt?.(visibleTranslated) ?? ""
  }, [expanded, expansionTab, visibleTranslated, getStatisticalBt])

  // Stable rail handlers
  const handleRowMouseEnter = () => {
    // 2026-08-08: under the playback-follow hover lock this "enter" is the
    // browser re-firing hover as content slides beneath a parked cursor —
    // summoning the rail from it made the rail drift row-to-row.
    if (rowRef.current?.closest("[data-follow-hover-lock]")) return
    setIsHovering(true)
    // AQU-354: a fresh hover re-summons the rail if it had idle-collapsed.
    registerRailActivity()
  }
  const handleRowMouseMove = () => {
    // After an in-place hover-lock lift the browser never re-fires mouseenter
    // (the cursor hasn't crossed a row boundary) — the first REAL movement
    // inside the row re-summons the rail instead.
    if (isHovering) return
    if (rowRef.current?.closest("[data-follow-hover-lock]")) return
    setIsHovering(true)
    registerRailActivity()
  }
  const handleRowMouseLeave = () => {
    // Clear immediately. A grace timer lets the previous hovered row overlap
    // the next one, producing three rails when an editor is also focused.
    setIsHovering(false)
  }
  const handleRowFocusCapture = () => {
    // AQU-669: claim the exclusive focus pin for this cell. Because the table
    // holds a single owner, this simultaneously releases whichever row was
    // pinned before — no reliance on the previous row's focus-out.
    onRowFocusPin(cell.id)
    // AQU-354: focusing anything in the row re-summons an idle-collapsed rail.
    registerRailActivity()
  }
  const handleRowBlurCapture = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    // AQU-913: dismiss this cell's inline AI errors (draft + back-translation)
    // once focus has really left the cell. Evaluated BEFORE the containment
    // early-return below because it uses a wider notion of "still in the cell":
    // the error's info popover is portaled out of the row, so reading it must
    // not count as leaving, while the focus-pin release deliberately still
    // fires for that case (AQU-669).
    if (shouldDismissCellErrorsOnBlur(rowRef.current, next)) onClearCellErrors?.(cell.id)
    if (next && rowRef.current?.contains(next)) return
    // AQU-669: focus left the row entirely — relinquish the pin (only if this
    // row still holds it; a newer focus may already own it).
    onRowFocusRelease(cell.id)
    // FRO-248: clear source-text selection when focus leaves this row so the
    // "Add to terminology" toolbar never floats over a different row's content.
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
    // 2026-08-07 (wire b): with the timeline stacked above, a plain row click
    // also points the timeline at this cell (select chip, center, cue paused).
    // The workspace no-ops this outside the stacked media lens.
    onMediaRowActivate?.(cell.id)
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

  // Inline rule click → open the standard bottom-right violation toast. Keep
  // the row collapsed and clear the transient hover preview so one gesture
  // produces one violation surface.
  const openInlineRule = useCallback((ruleId: string, _anchor: HTMLElement) => {
    setHoveredRule(null)
    setOpenRuleId(ruleId)
  }, [])

  // AQU-664: hover ("wave over") a blot → snapshot its rect and preview the
  // rule explanation; mouse-out clears it. Snapshotting mirrors openInlineRule
  // (the blot node can detach on re-render before the popover positions).
  const handleRuleHover = useCallback((ruleId: string | null, anchor: HTMLElement | null) => {
    if (!ruleId || !anchor) {
      setHoveredRule(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    setHoveredRule({ ruleId, anchor: { getBoundingClientRect: () => rect } })
  }, [])

  const isMultiSelected = useIsSelected(cell.id)
  // AQU-646 stage 4c: THE BADGE WATCHES BOTH CELLS THIS ROW CAN FILE UNDER.
  //
  // It used to watch only the row's own id, so on a file with an audio-cue
  // sibling the rail's voice button — moved to `audioHome` by stage 3f, because
  // that is where the audio belongs — wrote its failures to `synth:<cue>` while
  // the badge listened on `synth:<subtitle>` and the two never met.
  //
  // MOVING IT TO `audioHome` ALONE WOULD HAVE TRADED ONE BLIND SPOT FOR THREE.
  // Stage 3f moved the rail button and nothing else, so three producers still
  // file under the ROW's cell: the audio lens's own CellVoicePanel (the primary
  // per-line generate control in the lens the dubbing workflow lives in),
  // dropping a voice from the dock onto the row, and "Voice together". None of
  // them has an error surface of its own — CellVoicePanel reads this status
  // only to know it is busy — so this badge is the whole of their failure
  // reporting, and pointing it at the cue would have silenced all three.
  //
  // Watching both is the honest question anyway: "did anything about THIS
  // ROW's voice fail". Where those producers should be writing is a separate
  // question from whether the row can see them, and answering it means moving
  // where audio LANDS, not just where a status goes.
  const ownSynthStatus = useTtsStatus(ttsStatusKey(cell.id))
  const homeSynthStatus = useTtsStatus(
    audioHome && audioHome.id !== cell.id ? ttsStatusKey(audioHome.id) : undefined,
  )
  // A RUN IN FLIGHT OUTRANKS AN ERROR, the same precedence the recorder's
  // button uses: with a stale failure on one key and a fresh attempt on the
  // other, showing the failure would announce the outcome of something still
  // running.
  const synthStatus =
    ownSynthStatus.kind === "loading" || ownSynthStatus.kind === "synthesizing"
      ? ownSynthStatus
      : homeSynthStatus.kind === "loading" || homeSynthStatus.kind === "synthesizing"
        ? homeSynthStatus
        : ownSynthStatus.kind === "error"
          ? ownSynthStatus
          : homeSynthStatus
  const isSynthBusy = synthStatus.kind === "loading" || synthStatus.kind === "synthesizing"
  const isSynthError = synthStatus.kind === "error"

  // FRO-297: Accessible label for the target editor textbox.
  // Format: "<ref> — <state>" so screen readers announce context on focus.
  // Uses cell.context (the canonical reference like "GEN 1:1") when available,
  // falls back to globalReferences[0], then rowIndex+1.
  const cellRef = cell.context?.trim()
    || cell.globalReferences?.[0]?.trim()
    || `row ${rowIndex + 1}`
  const validationControl = (
    <TargetValidationControl
      cellRef={cellRef}
      hasContent={hasContent}
      validationStatus={cell.validationStatus}
      activeValidators={cell.activeValidators}
      validationHistory={cell.validationHistory}
      currentUsername={username}
      validationRequirement={readValidationCount(project)}
      canValidate={canValidate}
      canValidateThisCell={canValidateThisCell}
      onValidationChange={emitValidationChange}
    />
  )
  const cellStateLabel =
    cell.status === "validated" ? "validated" :
    cell.status === "empty" ? "empty" :
    cell.activeValidators.includes(username) ? "self-validated" :
    "unvalidated"
  const editorAriaLabel = `${cellRef} — ${cellStateLabel}`

  // FRO-297: Grid-row keydown handler. Fires when the row wrapper div has
  // focus (not TipTap). Arrow keys / j / k navigate between rows; Enter
  // moves focus into the cell's TipTap editor (entering edit mode).
  const handleGridRowKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only act when the grid row wrapper itself is focused, not a child element
    // (child interactive elements handle their own keyboard events).
    if (e.target !== e.currentTarget) return
    // AQU-746: while the editor is mounting/focusing after an activation, capture
    // printable keystrokes here (the row wrapper holds focus in that window) and
    // buffer them for replay. Without this the character is dropped: it fires
    // before any editor exists to receive it. Only single printable keys — no
    // modifier chords, no navigation/IME keys — are text; everything else falls
    // through to the normal grid-navigation handling below.
    if (
      awaitingEditorFocusRef.current
      && e.key.length === 1
      && !e.metaKey
      && !e.ctrlKey
      && !e.altKey
    ) {
      e.preventDefault()
      pendingActivationInputRef.current += e.key
      return
    }
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
        // AQU-646 round 5: the row the TRANSPORT is on — the queue's cell, or
        // the line the linked picture is playing over. Exposed for the same
        // reason as the line above: the ring it draws is the same gold as
        // multi-select's, so a class check cannot tell the two apart.
        data-queue-row={isQueueRow ? "true" : undefined}
        tabIndex={0}
        aria-label={t("editor.row.cellAria", { ref: cellRef })}
        className={cn(
          // Flat row in a continuous list: tinted by hover/selection overlays,
          // not shadows. Depth is gone by design — the Linear model reserves
          // elevation for floating layers.
          "group relative grid gap-2 ps-2.5 pe-4 py-2 transition-colors duration-150 ease-out",
          // The mic-permission help is anchored in the action rail. While it
          // is open, this row must become its own higher stacking layer and
          // allow the popover to escape the row; otherwise neighbouring rows
          // and the sticky table header paint above it.
          showMicDeniedHelp ? "z-30 overflow-visible" : "overflow-hidden",
          hasInlineFootnotes && "gap-y-1 py-1.5",
          // Keyboard-focus ring for the grid row (only when focused directly,
          // not via a child element — :focus-visible + :not(:focus-within:not(:focus))).
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset",
          // Hover/active well via a subtle background overlay. The :not()
          // stands the shade down under the playback-follow hover lock —
          // synthetic hover from content sliding under a parked cursor.
          "[&:hover:not([data-follow-hover-lock]_*)]:bg-muted/50",
          expanded && "bg-muted/50",
          audioController.isPlaying && "bg-muted/40",
          // Multi-select: tinted fill + a subtle gold inset ring.
          isMultiSelected && "bg-primary/5 ring-1 ring-primary/40 ring-inset",
          // Open-comments accent — a soft inset ring.
          openCommentCount > 0 && "ring-1 ring-blue-400/50 ring-inset",
          // Timeline cursor (media lens): sky ring, same language as the
          // selected chip's ring.
          isMediaCursorRow && "bg-sky-500/5 ring-1 ring-sky-500/40 ring-inset",
          // Wire c: the row the queue is sounding — gold, like the active cue.
          isQueueRow && "bg-primary/5 ring-1 ring-primary/40 ring-inset",
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
        onMouseMove={handleRowMouseMove}
        onMouseLeave={handleRowMouseLeave}
        onFocusCapture={handleRowFocusCapture}
        onBlurCapture={handleRowBlurCapture}
        onMouseDownCapture={handleRowMouseDownCapture}
        onClick={handleRowClick}
        onKeyDown={handleGridRowKeyDown}
      >
        {/* Combined left gutter — select sits near the left edge (row uses
            ps-2.5); ms-2 opens space before the badge stack, then a tight
            gap to the verse number. Fixed track keeps Source header-aligned. */}
        <div className="flex h-full items-start self-stretch py-1.5">
          {castGutter && (
            <div className="me-2 flex w-10 shrink-0 flex-col items-center">
              <div className="mb-1 h-4 shrink-0" aria-hidden />
              {/* 32px circles centered ON THE VERSE NUMBER (Sam 2026-08-07):
                  same spacer + first-line box as the number column, so the
                  circle's midpoint rides the number's midpoint; the circle
                  overflows the line box symmetrically. */}
              <span
                className="flex items-center justify-center"
                style={{ height: `calc(${sourceFontSize}px * 1.6)` }}
              >
                {gutterVoice && (
                  <CastGutterVoice
                    voice={gutterVoice}
                    explicit={gutterExplicit}
                    castName={gutterCastName}
                    editable={editable && Boolean(onAssignCastVoice)}
                    voices={gutterVoices}
                    showLanguageBadge={gutterLanguageBadge}
                    onPick={(voiceId, opts) => onAssignCastVoice?.(cell, voiceId, opts)}
                    onClear={onClearCastVoice ? (opts) => onClearCastVoice(cell, opts) : undefined}
                  />
                )}
              </span>
            </div>
          )}
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
          <div className="flex w-5 shrink-0 flex-col items-center">
            <div className="mb-1 h-4 shrink-0" aria-hidden />
            <AppTooltip content={isMultiSelected ? t("editor.row.selectedTooltip") : t("editor.row.selectTooltip")} side="right">
              <button
                type="button"
                role="checkbox"
                aria-checked={isMultiSelected}
                aria-label={isMultiSelected ? t("editor.row.selectedAria") : t("editor.row.selectAria")}
                onPointerDown={onSelectionPointerDown}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-md border",
                  "touch-none cursor-ns-resize transition-[opacity,transform,color,background-color] duration-150 ease-out",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2",
                  isMultiSelected
                    ? "border-transparent bg-primary text-primary-foreground opacity-100"
                    : "border-border bg-card text-muted-foreground/70 opacity-60 hover:text-primary [.group:hover:not([data-follow-hover-lock]_*)_&]:opacity-100",
                )}
              >
                {isMultiSelected ? (
                  <Check className="h-3 w-3" strokeWidth={3} />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                )}
              </button>
            </AppTooltip>
          </div>
          {/* Badges + verse number — ms-2 opens space after the select. */}
          <div className="ms-2 flex min-w-0 flex-1 items-start gap-0.5">
            {/* Spacer is a sibling of the badge stack (not inside it) so
                gap-0.5 only spaces stacked badges — a lone badge stays
                level with the select control, which has no flex gap. */}
            <div
              data-testid="gutter-status-badges"
              className="flex w-5 shrink-0 flex-col items-center"
            >
              <div className="mb-1 h-4 shrink-0" aria-hidden />
              <div className="flex flex-col items-center gap-0.5">
                {(isStaleSource || isUpstreamStaleSource) && hasContent && (
                  <StaleSourceIndicator
                    cellId={cell.id}
                    staleCellIds={isStaleSource ? new Set([cell.id]) : new Set()}
                    upstreamStaleCellIds={isUpstreamStaleSource ? new Set([cell.id]) : new Set()}
                  />
                )}
                {showFormattingLossWarning && (
                  <AppTooltip
                    content={t("editor.source.formattingLossTooltip")}
                    className="max-w-xs"
                  >
                    <span
                      role="img"
                      aria-label={t("editor.source.formattingLossTooltip")}
                      data-testid="formatting-loss-warning"
                      className={cn(
                        gutterIconShell,
                        "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      <Bold className="h-3 w-3" />
                    </span>
                  </AppTooltip>
                )}
                {((isSynthBusy && !audioLens) || isSynthError) && (
                  <SynthStatusBadge status={synthStatus} cellId={cell.id} projectId={project.id} onOpenAudioSetup={onOpenAudioSetup} />
                )}
                {/* AQU-599: persistent "has comment" indicator. Unlike the
                    action-rail comment button (which only appears on
                    hover/focus), this icon stays visible whenever the cell
                    carries an open comment. Clicking opens the comments panel. */}
                {onOpenComments && openCommentCount > 0 && (
                  <AppTooltip content={t("editor.comments.open", { count: openCommentCount })}>
                    <button
                      type="button"
                      aria-label={t("editor.comments.openAria", { count: openCommentCount })}
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-blue-500 transition-colors hover:bg-blue-500/10 hover:text-blue-600"
                      onClick={() => onOpenComments(cell.id)}
                    >
                      <MessageCircle className="h-3.5 w-3.5" fill="currentColor" fillOpacity={0.15} />
                    </button>
                  </AppTooltip>
                )}
              </div>
            </div>
            {/* Verse / line number (severity tint). */}
            <div className="flex min-w-0 flex-1 flex-col items-center">
              <div data-testid="gutter-strip-spacer" className="mb-1 h-4" aria-hidden />
              <div className="flex w-full items-start justify-center">
                {numberPill}
              </div>
            </div>
          </div>
        </div>

        {/* Source column. In Audio mode there's no need for source text to
            voice a line, so the column is REPLACED with this cell's voice
            controls (character picker, generate, play, make-a-character). In
            Text mode it shows the source text as usual. */}
        {audioLens ? (
          // AQU-768: the panel resolves this line's active voice from `settings`
          // itself — don't pre-resolve it here (a stale-prone JSX IIFE deep in
          // this huge row let the React Compiler serve a stale voice, so a
          // freshly-picked voice didn't stick in the trigger).
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
              session={audioLens.session}
              username={audioLens.username}
              onAssign={(voiceId) => audioLens.onAssignCast(cell.id, voiceId)}
              onAfterGenerate={audioLens.onAfterGenerate}
              onPlay={() => audioLens.onPlayCell(cell.id, cell)}
              onMakeCharacter={() => audioLens.onMakeCharacterFromCell(cell.id)}
            />
          </div>
        ) : (
          <div
            data-showcase="editor.source"
            ref={sourceColRef}
            className={cn(
              // The showcase node IS the text surface so it fills the whole
              // source column. pe-7 clears the floating pencil.
              // select-text: global chrome disables selection; source must stay
              // selectable for add-to-termbase / Ask AI from selection.
              // AQU-1101: min-w-0 + break-words. `minmax(0,1fr)` floors the
              // TRACK, but a grid item keeps `min-width: auto` and would still
              // overflow its area on an unbreakable token; min-w-0 lets it
              // shrink and break-words (inherited by the text below) breaks the
              // token instead of blowing the column out.
              "relative flex h-full min-h-[40px] min-w-0 flex-col break-words rounded-lg px-2 py-1.5 pe-7 select-text transition-[colors,opacity]",
              // Match the target well — same muted fill + ring (not a darker
              // primary-tinted edit chrome).
              "focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
              sourceEditing && "bg-muted ring-1 ring-ring/40 ring-inset",
              isSynthBusy && "opacity-70",
            )}
            dir={sourceCellDirection}
            aria-label={t("editor.source.textAria")}
            data-editor-cell-surface="source"
            data-cell-type="source"
            style={{ fontSize: `${sourceFontSize}px`, lineHeight: "1.6" }}
            onMouseUp={(!sourceEditing && (onAddConceptFromSelection || onAskAiFromSelection)) ? handleSourceMouseUp : undefined}
          >
            {/* Source-selection toolbar. Appears when source text is selected:
                "Ask AI" pushes the selection into the agent as a context chip,
                "Add to terminology" opens a popover to create an entry, and a
                "View term" button appears when the selection matches an active concept. */}
            {(sourceSelection || addTermOpen) && (
              <SourceSelectionToolbar
                sourceSelection={sourceSelection ?? capturedSelectionRef.current ?? ""}
                concepts={terminologyConcepts}
                onAskAi={handleAskAiFromSelection}
                onAddToTermbase={onAddConceptFromSelection ? handleCreateTerm : undefined}
                addConceptBlockedReason={addConceptBlockedReason}
        canApproveConcept={canApproveConcept}
                onAddOpenChange={handleAddTermOpenChange}
                onViewConcept={onOpenTerminologyConcept}
                onToolbarMouseDown={handleToolbarMouseDown}
                onToolbarMouseUp={handleToolbarMouseUp}
              />
            )}
            {/* Source-edit affordance (project_lead+, non-live projects). Emits
                source.cell.commit — the template-owner correction that propagates
                downstream. Read-only source stays the default; editing is explicit.
                Floated to the column's top-right so it costs no layout, rather
                than taking a slot in the context line below — that line is
                reserved for column alignment and is usually empty, so it has no
                room to spare. */}
            {canEditSourceForCell ? (
              <AppTooltip content={sourceEditing ? t("editor.source.doneEditing") : t("editor.source.editText")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={sourceEditing ? t("editor.source.doneEditing") : t("editor.source.editText")}
                  aria-pressed={sourceEditing}
                  onClick={() => setSourceEditing((v) => !v)}
                  className={cn(
                    "absolute end-1 top-1 z-10 shrink-0",
                    sourceEditing
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground/50 opacity-0 hover:text-foreground focus-visible:opacity-100 [.group:hover:not([data-follow-hover-lock]_*)_&]:opacity-100",
                  )}
                >
                  <Pencil />
                </Button>
              </AppTooltip>
            ) : sourceReadOnlyReasonForCell ? (
              // Force-locked source lane (DCS pin): keep an explained
              // affordance where the pencil would be instead of letting it
              // silently vanish (AQU-615 review nit).
              <AppTooltip content={sourceReadOnlyReasonForCell} className="max-w-xs">
                <span
                  aria-label={t("editor.source.locked")}
                  className="absolute end-1 top-1 z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 focus-visible:opacity-100 [.group:hover:not([data-follow-hover-lock]_*)_&]:opacity-100"
                >
                  <Lock className="size-3" />
                </span>
              </AppTooltip>
            ) : null}
            {/* Context line. Rendered even when empty: its 20px (h-4 + mb-1)
                mirrors the target column's header lane, and that mirror is what
                puts the two columns' first text lines on the same baseline. Drop
                it for context-free cells and every such row's source text rides
                20px above its translation — the target lane can't be made
                conditional to match, because it also reserves the strip the
                floating action rail occupies. */}
            <div data-testid="source-context-line" className={cn("mb-1 flex h-4 items-center gap-2 text-xs text-muted-foreground", showCellLabel ? "justify-start text-left" : "justify-center text-center")} dir="ltr">
              {/* AQU-646: the character, on the SOURCE side too (Sam,
                  2026-08-26) — "put that character label also in the top left
                  of source cells… we'll just scoot the time range over".

                  THE SAME VALUE THE TARGET CORNER SHOWS, deliberately: Sam's
                  call was that these two corners agree with EACH OTHER, so both
                  read the one `labelText` and both ride the "Show cell labels"
                  preference. AQU-1018 did not weaken that — it only gave
                  `labelText` a `cast_name` rung beneath the assigned voice, so
                  the corners now agree with the timeline/recorder/exports in the
                  cases where they used to agree on NOTHING. The two names still
                  are not interchangeable, and an assigned voice still wins.

                  `dir="auto"` because the lane is forced LTR for timecodes and
                  a name is not a timecode. The width cap is what does the
                  scooting: a long character name truncates rather than pushing
                  the timing out of the row. */}
              {showCellLabel && (
                <AppTooltip content={labelText} disabled={!labelText}>
                  <span data-testid="source-cell-label" dir="auto" className="max-w-[45%] shrink-0 truncate">
                    {labelText}
                  </span>
                </AppTooltip>
              )}
              {/* A TIMECODE IS NOT SHOWN HERE ANY MORE (Sam, 2026-08-27,
                  relaying the client): it moved to the foot of the cell — see
                  `source-timing-line` — so the character label has this corner
                  to itself. Other context, a scripture reference like
                  "GEN 1:1", still belongs at the top: it names what the line IS
                  rather than when it happens, and it is centred as it was. */}
              {!contextIsTimecode && <span className="min-w-0 truncate">{cell.context}</span>}
            </div>
            <SourceReferenceAttachments metadata={cell.metadata} />
            {sourceEditing ? (
              <TranslatedEditor
                cellId={`${cell.id}::source`}
                initialPlain={sourceDraft?.value ?? sourceSeed.text}
                initialHtml={sourceDraft?.valueHtml ?? sourceSeed.html}
                onCommit={handleSourceCommit}
                onBlur={() => setSourceEditing(false)}
                editable
                // Size to content like the read surface — compactHeight skips
                // the h-full / min-h-[40px] stretch that was jumping the row.
                compactHeight
                ariaLabel={t("editor.source.editText")}
                placeholder={t("editor.source.placeholder")}
                className="w-full !px-0"
              />
            ) : (cell.medium !== "media" && (sourceDraft?.valueHtml || cell.originalHtml)) ? (
              <SanitizedRichHtml
                html={sourceDraft?.valueHtml || cell.originalHtml || ""}
                idmlStyleCatalog={idmlStyleCatalog}
                idmlParagraphStyleId={idmlParagraphStyleId}
              />
            ) : (
              <UsfmSourceText
                // AQU-646: an imported media segment's stored `value` is the
                // filename; once transcribed, the ASR transcript IS the source
                // text users translate. Non-media cells are unaffected.
                // AQU-847: media rows skip the HTML branch above entirely — a
                // transcript is plain text, and letting `originalHtml` win
                // there is what pinned the file title over the transcript once
                // any source commit had landed.
                text={displayedSourceText(cell, sourceDraft?.value)}
                highlights={highlights}
                ranges={sourceRanges}
                showEvidence={examplesExpanded}
                onRangeClick={openInlineRule}
                concepts={terminologyConcepts}
                onViewConcept={onOpenTerminologyConcept}
                footnotePanelActive={footnotePanelActive}
                footnoteNumberOffset={sourceFootnoteNumberOffset}
              />
            )}
            {cellExamples.length > 0 && (
              <ExamplePanel examples={cellExamples} />
            )}
            {/* THE TIMING, AT THE FOOT OF THE CELL. Rendered ONLY for a
                timecode, and that asymmetry with the lane above is deliberate:
                the top lane is reserved even when empty because its 20px is
                what keeps the source and target columns' first lines on one
                baseline, while nothing below the text mirrors anything — so an
                always-on strip here would be wasted height on every scripture
                row in the app. */}
            {contextIsTimecode && (
              <div
                data-testid="source-timing-line"
                data-context-kind="timecode"
                className="mt-1 flex h-4 items-center justify-start text-left text-xs text-muted-foreground"
                dir="ltr"
              >
                <span className="min-w-0 truncate">{cell.context}</span>
              </div>
            )}
          </div>
        )}

        {/* Target column — TipTap is inline so typing is unchanged. Everything
            else (waveform, transcript preview, backtranslation, infractions
            detail) lives in the expansion panel. pe-9 reserves space for the
            ever-present chevron at the right edge. */}
        <EditorTargetCellColumn
          data-showcase="editor.target"
          className={cn(
            "relative flex flex-col ps-3 pe-9 transition-opacity",
            isSynthBusy && "opacity-70",
          )}
          fontSize={targetFontSize}
          busy={isSynthBusy}
          leading={healthCalculationsEnabled ? (
            <HealthRibbon
              point={healthRibbonPoint}
              hasMajorIssue={hasMajorInfraction}
              hasIssue={hasAnyIssue}
            />
          ) : undefined}
          header={(
            <>
            {showCellLabel && (
              <AppTooltip content={labelText} disabled={!labelText}>
                <span className="max-w-[60%] truncate">
                  {labelText}
                </span>
              </AppTooltip>
            )}
            <CellPresenceBadges peers={remoteCellPresence} />
            {/* AQU-1041: no AI-draft tag here. The cell header renders the same
                for a machine draft as for a human-typed one. The underlying
                `cell.aiDrafted` provenance stays — the org overview's AI-drafted
                stat, the selection bar's bulk-validate eligibility, and the
                editor's draft-hydration rules all still read it. */}
            </>
          )}
        >
          <div className="flex flex-1 flex-col">
            {/* Target is a cheap read surface at rest. It upgrades to TipTap
                only for the active cell, which keeps scrolling from mounting
                dozens of ProseMirror instances. */}
            {/* AQU-592: the validate button sits to the LEFT of the editing cell
                so validating keeps the reviewer's gaze on the TARGET. */}
            <div className="flex flex-1 gap-1.5">
              {validationControl}
            <EditorTargetCellWell
              onClick={(event) => {
                if (isEditorActive) return
                event.stopPropagation()
                requestTargetEdit(idmlConfiguration
                  ? idmlPointerSelectionFromPoint(event.nativeEvent, targetReadContentRef.current)
                  : null)
              }}
              compact={hasInlineFootnotes}
              empty={!visibleTranslated?.trim()}
            >
                {isEditorActive ? (
                  <TranslatedEditor
                    ref={translatedEditorRef}
                    cellId={cell.id}
                    initialPlain={visibleTranslated}
                    initialHtml={visibleTranslatedHtml}
                    idmlConfiguration={idmlConfiguration}
                    initialIdmlSelection={pendingIdmlPointerSelectionRef.current}
                    onInitialIdmlSelectionApplied={() => {
                      pendingIdmlPointerSelectionRef.current = null
                    }}
                    onIdmlValidationError={setWriteError}
                    // AQU-667: only authoritative when we're not masking it with a
                    // local human draft — then `visibleTranslated` IS cell.translated.
                    aiDrafted={!localTargetDraft && cell.aiDrafted}
                    onCommit={handleEditorCommit}
                    pendingInputRef={pendingActivationInputRef}
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
                    infractions={blotInfractions}
                    ruleSeverity={ruleSeverity}
                    waivedRuleIds={waivedRuleIds}
                    onRuleClick={openInlineRule}
                    onRuleHover={handleRuleHover}
                    onLiveTextChange={setLiveTargetText}
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
                  <EditorTargetReadSurface
                    aria-readonly={!editable || isLoading || Boolean(lockHolderLabel)}
                    aria-label={editorAriaLabel}
                    data-target-read-view
                    dir={targetCellDirection}
                    lang={project.targetLanguage || undefined}
                    tabIndex={editable && !isLoading && !lockHolderLabel ? 0 : undefined}
                    editable={editable && !isLoading && !lockHolderLabel}
                    subdued={showCompletionOverlay}
                    empty={!visibleTranslated?.trim()}
                    preserveWhitespace={Boolean(idmlConfiguration)}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestTargetEdit(idmlConfiguration
                        ? idmlPointerSelectionFromPoint(event.nativeEvent, targetReadContentRef.current)
                        : null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      event.stopPropagation()
                      requestTargetEdit()
                    }}
                  >
                    {/* OPS-3: `data-ph-mask` is PostHog's maskTextSelector
                        (src/lib/posthog.ts). Session replay masks inputs, but
                        the draft translation is rendered page text, not an
                        input — without this it is replayed verbatim to a US
                        processor. Tagged on the shared wrapper rather than each
                        renderer so a new target-text variant inherits the mask
                        instead of having to remember it. */}
                    <div ref={targetReadContentRef} data-ph-mask>
                      {overlayDraftText !== undefined ? (
                        <span data-remote-presence-draft>
                          {overlayDraftText}
                        </span>
                      ) : idmlConfiguration && visibleTranslatedHtml ? (
                        <TargetIdmlHtml
                          html={visibleTranslatedHtml}
                          idmlStyleCatalog={idmlStyleCatalog}
                          idmlParagraphStyleId={idmlParagraphStyleId}
                        />
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
                            showKeyTermHighlights={showTargetKeyTermHighlights}
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
                  </EditorTargetReadSurface>
                )}
              {/* FRO-204: Terminology highlight popover — controlled via termChipState.
                  Anchored to the highlighted term that was clicked.
                  We pass a dummy <span/> trigger so TermLookupPopover renders
                  the popover body; the BaseUI Popover controlled-open + external
                  anchor positions it on the clicked highlight. */}
              {termChipState && (
                <TermLookupPopover
                  sourceTerm={termChipState.term}
                  concepts={terminologyConcepts}
                  onViewConcept={onOpenTerminologyConcept}
                  open
                  onOpenChange={(isOpen: boolean) => { if (!isOpen) setTermChipState(null) }}
                  anchor={termChipState.anchor}
                >
                  <span />
                </TermLookupPopover>
              )}
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
                        className="ms-0.5 inline-block h-3.5 w-[2px] -mb-0.5 animate-pulse bg-primary/70 align-middle"
                      />
                    </p>
                  ) : (
                    /* Pre-stream spinner — centered so it doesn't overlap
                       any existing target text peeking through the dimmed
                       editor underneath. */
                    <div className="m-auto flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-muted-foreground">
                      <Spinner className="size-3.5" aria-hidden />
                      <span>
                        {loadingPhase === "searching"
                          ? t("editor.ai.lookingUpExamples")
                          : t("editor.ai.generatingTranslation")}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {/* Pending autopilot draft — verified text a contextual run
                  staged for this cell. Only rendered while the target is
                  still empty AND the cell is not being edited: a suggestion
                  must never cover work that exists, nor sit under a caret.
                  Accepting routes through handleEditorCommit, so it lands as
                  an ordinary human edit with every normal guard applied. */}
              {!hasTranslatedText && !showCompletionOverlay && !isEditorActive && (
                <ContextualDraftCard
                  cellId={cell.id}
                  projectId={project.id}
                  fileId={cell.fileId}
                  targetLang={activeLane}
                  editable={editable}
                  dir={targetCellDirection}
                  onAccept={(text) => handleEditorCommit({ value: text, valueHtml: text })}
                />
              )}
            </EditorTargetCellWell>
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
            {/* AQU-664: terminology violations surface solely via the inline
                `violation-blot-term` decoration in the editor — the amber
                advisory band was removed so a forbidden rendering shows one
                signal (the blot), not two. */}
            {/* AQU-891: never render the raw provider message here — a 413 from
                the chat proxy is a JSON payload, and it lands on every cell in
                a paragraph draft. InlineAiError shows a plain-language line and
                keeps the verbatim text in a copyable popover. */}
            {error && <InlineAiError message={error} className="mt-0.5" />}
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
                ? // i18n-exempt "searching" is a loading-phase tag, not copy
                  (loadingPhase === "searching"
                    ? t("editor.row.draftSearching", { cellRef })
                    : t("editor.row.draftGenerating", { cellRef }))
                : isLoading && completionPreview
                  ? t("editor.row.draftPreviewReady", { cellRef })
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
                  aria-label={t("common.dismiss")}
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
                <span>{t("common.saved")}</span>
              </div>
            )}
          </div>
        </EditorTargetCellColumn>

        {/* Floating action rail — anchored to the row's right edge, aligned
            with the target column's header lane so it never covers the target
            text. z-20 so it sits above the sticky column header (z-10).
            Without this, when a row is positioned at the very top of the
            scroll container, the sticky header's stacking context wins (rows
            are position:relative with auto z-index, so the row's local z-10
            doesn't escape the sticky header's z-10 context). */}
        <div className="pointer-events-none absolute end-2 top-0.5 z-20 flex">
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
              <TargetDraftActions
                targetText={visibleTranslated}
                status={cell.status}
                editable={editable}
                isAnonymous={Boolean(isAnonymous)}
                isCompletionConfigured={isCompletionConfigured}
                isCompletionAvailable={isCompletionAvailable}
                isLoading={isLoading}
                onDraft={completeSingleAndReturn}
                onRegenerate={() => onCompleteSingle(cell, { regenerate: true })}
                onAiSetupNeeded={onAiSetupNeeded}
                onDragStart={onDragStart}
                onDragEnter={onDragEnter}
                onConfirmOpenChange={setShowGenerateConfirm}
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
                    tooltip={groupBusy ? t("editor.ai.generating") : t("editor.ai.draftParagraph", { count: paragraphGroupSize })}
                    onClick={() => {
                      if (groupBusy) return
                      setShowParagraphConfirm(true)
                    }}
                    disabled={groupBusy}
                    pulsing={groupBusy}
                  />
                )
              })()}

              {/* FRO-237: Direct mic button on the rail when no audio — one-click
                  action without needing to open a popover ("just hit the record
                  mic — quick action"). Replaces the redundant Record item inside
                  the ⋯ popover. When audio IS present, FRO-236's Play icon on
                  the overflow button already gives a direct play affordance.
                  WARN fix: the button must NOT be disabled when micDenied —
                  disabled elements receive no mouse events, so the "click for
                  help" affordance is unreachable. Instead keep it enabled and
                  route clicks to the denied-help popover. */}
              {onOpenRecording && editable && (() => {
                const unsupportedReason = getUnsupportedReason()
                const isUnsupported = unsupportedReason !== null
                const micTooltip = micDenied
                  ? t("editor.audio.micBlockedTooltip")
                  : isUnsupported
                    // Browser-capability diagnostic from outside any component:
                    // stays English (AQU-510).
                    ? `Recording unavailable — ${unsupportedReason}`
                    : t("editor.audio.record")
                return (
                  <div ref={micHelpAnchorRef} className="relative">
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
                    {micDenied && showMicDeniedHelp && (
                      <Popover open onOpenChange={(open) => { if (!open) setShowMicDeniedHelp(false) }}>
                        <PopoverContent
                          anchor={micHelpAnchorRef}
                          side="bottom"
                          align="end"
                          className="w-52 gap-1 p-3 text-[11px] leading-snug"
                        >
                          <PopoverTitle className="text-[11px] font-semibold">
                            {t("editor.audio.micBlockedTitle")}
                          </PopoverTitle>
                          <PopoverDescription className="text-[11px] leading-snug">
                            {t("editor.audio.micBlockedHelp")}
                          </PopoverDescription>
                          <button
                            type="button"
                            onClick={() => setShowMicDeniedHelp(false)}
                            className="mt-1 self-start text-[10px] underline text-muted-foreground hover:text-foreground"
                          >
                            {t("common.dismiss")}
                          </button>
                        </PopoverContent>
                      </Popover>
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
                  onTakeSaved={onTakeSaved}
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
                  tooltip={audioController.isPlaying ? t("common.pause") : t("editor.audio.play")}
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
              {/* AQU-646 stage 3f: THE VOICE GOES WHERE THE AUDIO LIVES.
                  The mic a few pixels away already redirects to the heard line
                  performing this subtitle; this button did not, so a generated
                  voice landed on the subtitle cell — which the timeline cannot
                  draw, because it resolves takes over the cues. Two buttons in
                  one row putting their audio in two different places.

                  The WORDS are still this row's own translation, which is where
                  they live and always did. Only the destination moves. */}
              <CellTtsButton
                cellId={audioHome?.id ?? cell.id}
                // …BUT THE VOICE STILL COMES OFF THIS ROW. Character voices are
                // assigned on the subtitle and stored by ITS cell id, so handing
                // the cue's id to the cast lookup — which redirecting `cellId`
                // alone did — found no assignment and fell through to the
                // project default. Every character's line was generated, and
                // durably attached, in the narrator's voice, while the character
                // gutter in the same row went on showing the right name
                // (2026-08-27).
                voiceCellId={cell.id}
                text={visibleTranslated}
                original={effectiveSourceText(cell)}
                context={cell.context}
                cellLabel={cell.cellLabel}
                sourceLanguage={project.sourceLanguage}
                targetLanguage={project.targetLanguage}
                projectTtsSettings={project.ttsSettings}
                cellTtsSettings={cell.ttsSettings}
                // OFF THE HOME, NOT OFF THE ROW. This is a replay button
                // before it is a generate one, and the clip it replays lives
                // where it was written — read these off the subtitle and it
                // finds nothing and re-synthesizes on every press.
                generatedVoiceAudioId={audioHome?.selectedGeneratedVoiceAudioId}
                attachments={audioHome?.attachments ?? cell.attachments}
                projectId={project.id}
                fileId={audioHome?.fileId ?? cell.fileId}
                // Sam, 2026-08-25: a subtitle performed by two heard lines
                // voices BOTH, so neither is left silent. Only the first is
                // played back; the rest are generated alongside it.
                alsoAttachTo={audioHomes
                  ?.slice(1)
                  .map((c) => ({ cellId: c.id, fileId: c.fileId }))}
                // A cue sibling exists but nothing performs this line — about
                // ten an episode. There is nowhere to put a voice, and writing
                // it to the subtitle is exactly the bug above.
                disabled={!editable || audioHomes === null}
              />

              {editable && !isLoading && (
                <RailButton
                  icon={<NotebookPen className="h-3.5 w-3.5" />}
                  tooltip={t("editor.footnote.add")}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    captureFootnoteAnchor()
                  }}
                  onClick={() => openAddFootnoteDialog()}
                />
              )}

              <TargetReferenceActions
                cellId={cell.id}
                openCommentCount={openCommentCount}
                onOpenComments={onOpenComments}
                onOpenHistory={onOpenHistory}
              />

              {onSeekToCue && (
                <RailButton
                  icon={<Play className="h-3.5 w-3.5" />}
                  tooltip={t("editor.cue.playFrom")}
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
      <div className="ps-[3.75rem] pe-4 pb-2">
        <CellExpansion
          open={expanded}
          tab={expansionTab}
          onTabChange={setExpansionTab}
          onClose={() => setExpanded(false)}
          tabs={[
            {
              value: "health",
              icon: <Activity className="h-3 w-3" />,
              label: t("editor.expansion.retrievalSupport"),
              renderContent: () => (
                <div className="space-y-1.5 py-3 text-xs text-muted-foreground">
                  {healthRibbonPoint.stage === "validated" ? (
                    <>
                      <p className="font-medium text-foreground">{t("agentWorkspace.assuranceValidated")}</p>
                      <p>
                        {cellInfractions.length > 0
                          ? t("editor.assurance.validatedWithInfractions")
                          : t("editor.assurance.validatedClean")}
                      </p>
                    </>
                  ) : healthRibbonPoint.stage === "automatic" ? (
                    healthValue === undefined ? (
                      <p>{t("agentWorkspace.healthAwaiting")}</p>
                    ) : (
                      <>
                        <p>
                          {t("agentWorkspace.cellEstimate")} <span className="font-medium text-foreground">{Math.round(healthValue)}%</span>
                          {smoothedHealthValue !== undefined && (
                            <> {t("agentWorkspace.localTrend")} <span className="font-medium text-foreground">{Math.round(smoothedHealthValue)}%</span></>
                          )}
                        </p>
                        <p>
                          {cellNeedsAttention
                            ? t("editor.assurance.lowerSupport")
                            : t("editor.assurance.betterSupport")}
                        </p>
                      </>
                    )
                  ) : healthValue === undefined ? (
                    <p>{t("agentWorkspace.sourceEvidenceUnavailable")}</p>
                  ) : (
                    <>
                      <p>
                        {t("agentWorkspace.sourceEvidence")} <span className="font-medium text-foreground">{Math.round(healthValue)}%</span>
                        {smoothedHealthValue !== undefined && (
                          <> {t("agentWorkspace.localTrend")} <span className="font-medium text-foreground">{Math.round(smoothedHealthValue)}%</span></>
                        )}
                      </p>
                      <p>{t("agentWorkspace.sourceEvidenceHelp")}</p>
                    </>
                  )}
                </div>
              ),
            },
            {
              value: "backtranslation",
              icon: <FileText className="h-3 w-3" />,
              label: t("editor.bt.label"),
              attentionDot: isBtStale ? "amber" : undefined,
              renderContent: () => (
                <BacktranslationPanel
                  cell={cell}
                  visibleTranslated={visibleTranslated}
                  editable={editable}
                  isBacktranslationConfigured={isBacktranslationConfigured}
                  isBacktranslating={isBacktranslating}
                  backtranslationError={backtranslationError}
                  statisticalGloss={statisticalGloss}
                  alignmentOpen={btAlignmentOpen}
                  onAlignmentOpenChange={setBtAlignmentOpen}
                  alignmentModel={alignmentModelForExpansion}
                  showAlignment={Boolean(getAlignmentModel)}
                  onBacktranslate={onBacktranslate}
                  onSaveBacktranslation={onSaveBacktranslation}
                  onAlignmentSeedChange={onAlignmentSeedChange}
                  confirmedSeeds={project.alignmentSeeds ?? []}
                />
              ),
            },
            ...(showFootnotesInExpansion ? [{
              value: "footnotes",
              icon: <NotebookPen className="h-3 w-3" />,
              label: t("editor.footnotes.label"),
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
              label: t("editor.expansion.recording"),
              attentionDot: transcriptNeedsAttention
                ? "amber"
                : (hasAudio || hasGeneratedVoice || (linkedTakes?.length ?? 0) > 0)
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
                        return v ? t("editor.voice.synthesizeWith", { name: v.name }) : t("editor.voice.dropToSynthesize")
                      })()}
                    </div>
                  )}
                  {/* BOTH/AND, not either/or (Sam, 2026-08-22): this row's own
                      audio first, then every take that lives on a heard line
                      performing it. A line can have both, and a reader who
                      opened this panel wants to see everything that sounds for
                      this line, not whichever one we ranked highest. */}
                  {hasAudio && (
                    <CellTakeBlock
                      project={project}
                      owner={cell}
                      timings={cellAudioTimings}
                      cellText={visibleTranslated}
                      editable={editable}
                      username={username}
                      session={rowSession}
                      onOpenRecording={onOpenRecording}
                      onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                      onCommitted={onCellCommitted}
                    />
                  )}
                  {hasGeneratedVoice && (
                    // A synthesized voice is nobody's performance: it can be
                    // recorded over, but not transcribed or cleaned up.
                    <CellTakeBlock
                      project={project}
                      owner={cell}
                      audioId={cell.selectedGeneratedVoiceAudioId}
                      timings={generatedVoiceTimings}
                      cellText={visibleTranslated}
                      editable={editable}
                      username={username}
                      session={rowSession}
                      onOpenRecording={onOpenRecording}
                      onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                      recordLabel={t("editor.audio.recordOver")}
                      readOnlyTranscript
                      header={
                        <span className="text-[11px] text-muted-foreground">
                          {t("editor.voice.aiGeneratedHint")}
                        </span>
                      }
                    />
                  )}
                  {linkedTakes?.map(({ cell: take, sharedWith }) => (
                    <CellTakeBlock
                      key={take.id}
                      project={project}
                      owner={take}
                      timings={take.selectedAudioId ? take.audioTimings?.[take.selectedAudioId] : undefined}
                      cellText={visibleTranslated}
                      editable={editable}
                      username={username}
                      session={rowSession}
                      onOpenRecording={onOpenRecording}
                      onUseAsCellText={(transcript) => handleEditorCommit({ value: transcript, valueHtml: transcript })}
                      onCommitted={onCellCommitted}
                      header={
                        <div data-testid="cell-linked-take" className="flex flex-col gap-0.5 border-t border-border pt-2">
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {t("editor.audio.heardLineAt", {
                              range: `${fmtClock(take.startTime ?? 0, true)}–${fmtClock(take.endTime ?? take.startTime ?? 0, true)}`,
                            })}
                          </span>
                          {sharedWith > 1 && (
                            // One heard line can perform several subtitle lines
                            // — real in this data, up to seven. Re-recording it
                            // changes all of them, and that should not be a
                            // surprise discovered afterwards.
                            <span className="text-[10px] text-muted-foreground">
                              {t("editor.audio.heardLineShared", { count: sharedWith - 1 })}
                            </span>
                          )}
                        </div>
                      }
                    />
                  ))}
                  {!hasAudio && !hasGeneratedVoice && !linkedTakes?.length && (
                    <div className="flex flex-col items-center gap-3 py-4 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground/50">
                        <Mic className="h-5 w-5" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("editor.audio.noAudioYet")}
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button
                          type="button"
                          variant="default"
                          onClick={() => onOpenRecording?.(cell.id)}
                          disabled={!editable || !onOpenRecording}
                        >
                          <Mic className="h-3 w-3" />
                          {t("editor.audio.recordShort")}
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
              label: t("editor.expansion.issues"),
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
                      {t("editor.issues.none")}
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
                            className="bg-card flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-start text-xs transition-all"
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 h-3 w-3 shrink-0",
                                isMajor ? "text-red-500" : "text-amber-500",
                              )}
                            />
                            <span className="flex-1">
                              <span className="font-medium text-foreground">
                                {rule ? translateRuleName(rule, t) : inf.ruleId}
                              </span>
                              <span className="ms-1 text-muted-foreground">
                                — {formatInfractionReason(inf, t)}
                              </span>
                            </span>
                            <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
                          </button>
                        )
                      })}
                      {waivedInfractions.length > 0 && (
                        <>
                          <div className="mt-2 px-1 text-xs text-muted-foreground">
                            {t("editor.issues.waived")}
                          </div>
                          {waivedInfractions.map((inf) => {
                            const rule = ruleMap.get(inf.ruleId)
                            return (
                              <button
                                key={`waived-${inf.ruleId}`}
                                type="button"
                                onClick={() => setOpenRuleId(inf.ruleId)}
                                className="bg-muted flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-start text-xs text-muted-foreground/70 transition-all"
                              >
                                <Check className="mt-0.5 h-3 w-3 shrink-0" />
                                <span className="flex-1">
                                  {rule ? translateRuleName(rule, t) : inf.ruleId}
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
                    label: t("editor.expansion.metadata"),
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
          <ViolationToast
            open
            onOpenChange={(next) => {
              if (!next) setOpenRuleId(null)
            }}
            infraction={inf}
            ruleName={translateRuleName(rule, t)}
            waivers={cell.waivers ?? []}
            onOpenRule={(ruleId) => {
              setOpenRuleId(null)
              onInfractionClick?.(ruleId)
            }}
            onWaive={handleWaive}
            onUnwaive={handleUnwaive}
          />
        )
      })()}

      {/* AQU-664: hover ("wave over") preview of a violation blot's rule
          explanation. Non-interactive and separate from the click toast — it
          appears on mouse-in and dismisses on mouse-out (see handleRuleHover /
          TranslatedEditor's blot hover handlers). Suppressed while the click
          toast is open so the two never stack. */}
      {hoveredRule && !openRuleId && (() => {
        const inf = blotInfractions.find((i) => i.ruleId === hoveredRule.ruleId)
        const rule = ruleMap.get(hoveredRule.ruleId)
        if (!inf || !rule) return null
        return (
          <Popover open>
            <PopoverContent
              anchor={hoveredRule.anchor}
              sideOffset={6}
              initialFocus={false}
              finalFocus={false}
              className="pointer-events-none w-72 space-y-1 p-3 text-sm"
            >
              <div className="font-medium">{translateRuleName(rule, t)}</div>
              <p className="text-xs text-muted-foreground">{formatInfractionReason(inf, t)}</p>
            </PopoverContent>
          </Popover>
        )
      })()}

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

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

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
  const t = useT()
  const description = draftableCount === totalCount
    ? t("editor.paragraph.confirmAll", { total: totalCount })
    : t("editor.paragraph.confirmPartial", { draftable: draftableCount, total: totalCount })

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent aria-labelledby="paragraph-draft-title" aria-describedby="paragraph-draft-desc">
        <DialogHeader>
          <DialogTitle id="paragraph-draft-title">{t("editor.paragraph.confirmTitle")}</DialogTitle>
          <DialogDescription id="paragraph-draft-desc">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>
            {t("editor.paragraph.confirmAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
