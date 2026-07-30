// Phase 2c-β: plain TipTap editor — no Y.Doc, no collaboration extension.
//
// Architecture (AD-2 / AD-3 v1):
//   - Read path:  `initialHtml` (or `initialPlain`) hydrates the editor when
//                 the cell mounts or when remote content lands and we're not
//                 focused. After a remote `event.applied` arrives while the
//                 user IS focused, the parent surfaces a banner and lets the
//                 user choose discard-and-reload vs. keep-my-edits.
//   - Write path: editor onUpdate is debounced to COMMIT_IDLE_MS; on idle
//                 (or blur, or programmatic flush) we serialize editor →
//                 HTML + plain text and call `onCommit({ value, valueHtml })`.
//                 The caller emits a `target.cell.commit` via the outbox,
//                 chained off `cell.targetEventId` and pinned to
//                 `cell.sourceEventId` (AD-9 staleness pin).
//
// Lock model (AD-1): the parent owns the WS focus lock via `useFocusLock`
// and passes `heldByLabel` here. When that's set the editor is read-only;
// collaborator identity is rendered on the live remote caret by the parent.

import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection, type Transaction } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import StarterKit from "@tiptap/starter-kit"
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react"
import type { RuleInfraction } from "@/lib/parsers/types"
import { createViolationDecorationExtension, violationPluginKey } from "@/lib/richtext/violation-decoration-plugin"
import { createKaraokeExtension, karaokePluginKey, type KaraokePluginState } from "@/lib/richtext/karaoke-plugin"
import { createTerminologyChipExtension, terminologyChipPluginKey } from "@/lib/richtext/terminology-chip-plugin"
import { createFootnoteDecorationExtension, footnoteDecorationPluginKey } from "@/lib/richtext/footnote-decoration-plugin"
import { UsfmFootnote } from "@/lib/richtext/footnote-node"
import {
  idmlEditableSlotPosition,
  idmlDiagnosticMessage,
  idmlEditorExtensions,
  isEditableIdmlSelection,
  prepareIdmlEditorContent,
  serializeIdmlEditorDocument,
  type IdmlEditorConfiguration,
} from "@/lib/richtext/idml-editor"
import {
  FOOTNOTE_NODE_NAME,
  buildUsfmPlainTextMap,
  pmToPlainOffset,
} from "@/lib/richtext/usfm-plain-text"
import {
  prepareEditorContent,
  sanitizeEditorHtml,
  sanitizeIdmlEditorHtml,
} from "@/lib/richtext/editor-content"
import { validateIdmlTranslation } from "@aquilla/idml-roundtrip"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import type { Concept } from "@/lib/terminology/types"
import { findActiveTimingIndex } from "@/lib/audio/timings"
import type { WordTiming } from "@/lib/codex-editor/types"
import type { TargetPresenceSelection } from "@/lib/sync/presence-store"
import {
  detectStrongTextDirection,
  type DirectionMode,
  type TextDirection,
} from "@/lib/text-direction"

/** Window before a quiet keystroke pause counts as a commit-worthy idle. */
export const COMMIT_IDLE_MS = 1_200
/**
 * AQU-664: much shorter debounce for the live terminology-violation check. The
 * blot recomputes off the live buffer at this cadence so a forbidden rendering
 * lights up nearly as-you-type instead of waiting on the commit-idle window.
 */
export const LIVE_CHECK_MS = 150
const PRESENCE_SELECTION_THROTTLE_MS = 120
export const PRESENCE_DRAFT_IDLE_MS = 650
export const PRESENCE_WORD_BATCH_SIZE = 2
/** Keep presence frames lightweight even if a malformed/imported cell is huge. */
export const MAX_PRESENCE_DRAFT_LENGTH = 16_384

function presenceWords(text: string): string[] {
  // Unicode letters/numbers/marks keep this useful outside English. Treat
  // apostrophes and hyphens inside a token as part of the same word so one
  // contraction or compound does not accidentally satisfy a two-word batch.
  return text.match(/[\p{L}\p{N}\p{M}]+(?:[-'’\u2010-\u2015][\p{L}\p{N}\p{M}]+)*/gu) ?? []
}

export function shouldPublishPresenceDraft(previous: string, next: string): boolean {
  const before = presenceWords(previous)
  const after = presenceWords(next)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const changedBefore = before.length - prefix - suffix
  const changedAfter = after.length - prefix - suffix
  return Math.max(changedBefore, changedAfter) >= PRESENCE_WORD_BATCH_SIZE
}

export function isPresenceWordBoundary(text: string, caretOffset: number): boolean {
  if (caretOffset <= 0) return false
  const preceding = Array.from(text.slice(0, caretOffset)).at(-1)
  return preceding !== undefined && /[\s\p{P}]/u.test(preceding)
}

export interface TranslatedEditorCommit {
  /** Plain-text value derived from editor content. */
  value: string
  /** HTML form of editor content (only the allowed inline marks survive). */
  valueHtml: string
}

export interface FootnoteInsertionAnchor {
  position: number
  from: number
  to: number
  plainPosition: number
  source: "selection" | "word" | "cursor" | "end"
  previewText?: string
  previewBefore?: string
  previewAfter?: string
}

interface IdmlInsertedRange {
  from: number
  to: number
}

function replaceIdmlSelectionWithPlainText(
  view: EditorView,
  text: string,
  requestedRange?: IdmlInsertedRange,
): IdmlInsertedRange | null {
  const selection = view.state.selection
  const fallbackPosition = idmlEditableSlotPosition(view.state.doc)
  const from = requestedRange?.from
    ?? (isEditableIdmlSelection(selection) ? selection.from : fallbackPosition)
  const to = requestedRange?.to
    ?? (isEditableIdmlSelection(selection) ? selection.to : fallbackPosition)
  if (from === null || to === null) return null

  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const nodes = lines.flatMap((line, index) => [
    ...(line.length > 0 ? [view.state.schema.text(line)] : []),
    ...(index < lines.length - 1 && view.state.schema.nodes.hardBreak
      ? [view.state.schema.nodes.hardBreak.create()]
      : []),
  ])
  const replacement = Fragment.fromArray(nodes)
  // Explicit caret placement: ReplaceStep maps a cursor at `from` with
  // assoc=-1 back to the *start* of the inserted text. Without setSelection
  // here, a desynced native DOM caret (EditorTable's selectNodeContents
  // collapse-to-end on empty IDML slots) keeps inserting at the same offset
  // and typed characters appear in reverse order.
  const insertEnd = from + replacement.size
  const transaction = nodes.length > 0
    ? view.state.tr.replaceWith(from, to, replacement)
    : view.state.tr.delete(from, to)
  transaction.setSelection(TextSelection.create(transaction.doc, nodes.length > 0 ? insertEnd : from))
  view.dispatch(transaction.scrollIntoView())
  return { from, to: insertEnd }
}

export interface TranslatedEditorHandle {
  getFootnoteInsertionAnchor: () => FootnoteInsertionAnchor | null
  insertFootnoteMarker: (marker: string, anchor?: FootnoteInsertionAnchor | null, anchorText?: string) => boolean
}

interface PendingFootnoteDelete {
  index: number
  label: string
}

interface TranslatedEditorProps {
  /** Stable cell id — switching cells re-hydrates the editor from html. */
  cellId: string
  /** Initial content. Plain string fallback used when html is absent. */
  initialHtml?: string
  initialPlain: string
  /** Strict IDML v2 editing contract. Invalid/future metadata is fail-closed. */
  idmlConfiguration?: IdmlEditorConfiguration | null
  /** Receives actionable protected-anchor errors for the parent row banner. */
  onIdmlValidationError?: (message: string | null) => void
  /**
   * AQU-667: the current authoritative value is an AI draft (sparkle / batch
   * "Draft all") that the store — not this editor — produced. When set and the
   * value changes, the editor absorbs it *even while focused* so the prediction
   * is visible and a later blur can't commit the pre-draft text over it. A
   * human's own in-flight edit commits with `aiDrafted=false`, so it keeps the
   * normal focused-editing / discard-and-reload banner path instead.
   */
  aiDrafted?: boolean
  onCommit: (snapshot: TranslatedEditorCommit) => void
  onFocus?: () => void
  onBlur?: () => void
  onSelectionChange?: (selection: TargetPresenceSelection | null) => void
  placeholder?: string
  className?: string
  compactHeight?: boolean
  editable?: boolean
  textDirection?: TextDirection
  directionMode?: DirectionMode
  lang?: string
  /** Remote lock holder — when present, the editor is read-only. */
  heldByLabel?: string | null
  infractions?: RuleInfraction[]
  ruleSeverity?: Map<string, "major" | "minor">
  waivedRuleIds?: Set<string>
  onRuleClick?: (ruleId: string, anchor: HTMLElement) => void
  /**
   * AQU-664: hover ("wave over") a violation blot to preview the rule
   * explanation. Fires with the blot's `data-rule-id` + the blot element on
   * mouse-in, and `(null, null)` on mouse-out so the caller can dismiss the
   * popover reliably. Mirrors the footnote-marker hover handlers below.
   */
  onRuleHover?: (ruleId: string | null, anchor: HTMLElement | null) => void
  /**
   * AQU-664: called on a short debounce with the live editor text (before the
   * ~1.2s commit-idle debounce fires) so the caller can recompute terminology
   * violations off the live buffer and surface the inline blot as-you-type.
   */
  onLiveTextChange?: (text: string) => void
  audioTimings?: WordTiming[]
  /** Audio playback time in seconds. Drives the karaoke decoration. */
  audioCurrentTime?: number
  /** Called on alt+click of a word when timings are present. */
  onSeekToTime?: (t: number) => void
  /**
   * Banner / change-while-editing reconciliation. When set, the parent has
   * received a remote `event.applied` for this cell while we hold the lock.
   * The editor stays editable; the banner offers a Discard-and-Reload action.
   */
  remoteChangedDuringEdit?: boolean
  onDiscardLocal?: () => void
  /**
   * Keyboard cell navigation. Up/Down move between cells (only when the caret
   * is at the first/last visual line, so multi-line cells still scroll
   * internally); Tab/Shift+Tab always move to the next/previous cell. The
   * parent resolves direction → target cell and focuses it (caret at end).
   */
  onNavigateCell?: (direction: "prev" | "next") => void
  /**
   * Optional managed terminology concepts. When provided, active concepts are
   * highlighted with a tiny status-tinted chip at the top-right of each match.
   * Defaults to undefined (feature off) so other call sites are unaffected.
   * Chip click exposes `data-source-term` for AQU-204 (TermLookupPopover).
   */
  terminologyConcepts?: Concept[]
  /**
   * AQU-204: Called when the user clicks a term chip in the editor.
   * Receives the sourceTerm string and the chip DOM element as an anchor.
   * The caller is responsible for opening TermLookupPopover.
   */
  onTermChipClick?: (term: string, anchor: HTMLElement) => void
  /** Number of automatic numeric footnotes before this cell in the current chapter/file. */
  footnoteNumberOffset?: number
  /** Show the footnote text on marker hover when no separate footnote panel is visible. */
  showFootnoteTooltips?: boolean
  /** Called when the user hovers a rendered target footnote marker. */
  onFootnoteHover?: (index: number | null) => void
  /**
   * AQU-297: Accessible label for the target editor textbox.
   * Should include the cell reference and validation state,
   * e.g. "GEN 1:1 — validated". Announced by screen readers.
   */
  ariaLabel?: string
  /**
   * AQU-297: Called when the user presses Escape while editing.
   * The editor commits any pending changes (via blur) and signals
   * the parent to return focus to the grid row wrapper.
   */
  onEscapeToGrid?: () => void
}

export const TranslatedEditor = forwardRef<TranslatedEditorHandle, TranslatedEditorProps>(function TranslatedEditor({
  cellId,
  initialHtml,
  initialPlain,
  idmlConfiguration = null,
  onIdmlValidationError,
  aiDrafted = false,
  onCommit,
  onFocus,
  onBlur,
  onSelectionChange,
  placeholder,
  className,
  compactHeight = false,
  editable = true,
  textDirection = "ltr",
  directionMode = "ltr",
  lang,
  heldByLabel,
  infractions,
  ruleSeverity,
  waivedRuleIds,
  onRuleClick,
  onRuleHover,
  onLiveTextChange,
  audioTimings,
  audioCurrentTime,
  onSeekToTime,
  remoteChangedDuringEdit,
  onDiscardLocal,
  onNavigateCell,
  terminologyConcepts,
  onTermChipClick,
  footnoteNumberOffset = 0,
  showFootnoteTooltips = true,
  onFootnoteHover,
  ariaLabel,
  onEscapeToGrid,
}, ref) {
  // Held in a ref so the editor's keydown handler — created once per cellId —
  // always sees the latest navigation callback without re-creating the editor.
  const onNavigateCellRef = useRef(onNavigateCell)
  useEffect(() => { onNavigateCellRef.current = onNavigateCell }, [onNavigateCell])
  const onEscapeToGridRef = useRef(onEscapeToGrid)
  useEffect(() => { onEscapeToGridRef.current = onEscapeToGrid }, [onEscapeToGrid])
  const onSelectionChangeRef = useRef(onSelectionChange)
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange }, [onSelectionChange])
  const textDirectionRef = useRef<TextDirection>(textDirection)
  useEffect(() => { textDirectionRef.current = textDirection }, [textDirection])
  const directionModeRef = useRef<DirectionMode>(directionMode)
  useEffect(() => { directionModeRef.current = directionMode }, [directionMode])
  const footnoteNumberOffsetRef = useRef(footnoteNumberOffset)
  useEffect(() => { footnoteNumberOffsetRef.current = footnoteNumberOffset }, [footnoteNumberOffset])
  const showFootnoteTooltipsRef = useRef(showFootnoteTooltips)
  useEffect(() => { showFootnoteTooltipsRef.current = showFootnoteTooltips }, [showFootnoteTooltips])
  const onFootnoteHoverRef = useRef(onFootnoteHover)
  useEffect(() => { onFootnoteHoverRef.current = onFootnoteHover }, [onFootnoteHover])
  const [pendingFootnoteDelete, setPendingFootnoteDelete] = useState<PendingFootnoteDelete | null>(null)
  const pendingFootnoteDeleteRef = useRef<PendingFootnoteDelete | null>(null)
  const idmlCompositionRangeRef = useRef<IdmlInsertedRange | null>(null)
  useEffect(() => {
    pendingFootnoteDeleteRef.current = pendingFootnoteDelete
  }, [pendingFootnoteDelete])
  const latestViolationStateRef = useRef({
    infractions: infractions ?? [],
    ruleSeverity: ruleSeverity ?? new Map<string, "major" | "minor">(),
    waivedRuleIds: waivedRuleIds ?? new Set<string>(),
  })

  const latestKaraokeStateRef = useRef<KaraokePluginState>({
    timings: audioTimings,
    activeIdx: -1,
    onSeekToWord: undefined,
  })

  const latestTerminologyConceptsRef = useRef<Concept[]>(terminologyConcepts ?? [])

  const preparedIdmlContent = useMemo(
    () => idmlConfiguration
      ? prepareIdmlEditorContent(idmlConfiguration, initialHtml, initialPlain)
      : null,
    [idmlConfiguration, initialHtml, initialPlain],
  )
  const [idmlError, setIdmlError] = useState<string | null>(preparedIdmlContent?.error ?? null)
  const onIdmlValidationErrorRef = useRef(onIdmlValidationError)
  useEffect(() => {
    onIdmlValidationErrorRef.current = onIdmlValidationError
  }, [onIdmlValidationError])
  useEffect(() => {
    setIdmlError(preparedIdmlContent?.error ?? null)
    if (preparedIdmlContent?.error) {
      onIdmlValidationErrorRef.current?.(preparedIdmlContent.error)
    }
  }, [preparedIdmlContent?.error])
  const idmlContext = idmlConfiguration?.kind === "ready"
    ? idmlConfiguration.context
    : null
  const idmlEditorKey = idmlConfiguration?.kind === "ready"
    ? `idml:2:${idmlConfiguration.context.metadata.anchorSequenceHash}:${idmlConfiguration.context.sourceHtml}`
    : idmlConfiguration?.kind === "error"
      ? `idml:error:${idmlConfiguration.error}`
      : "generic"

  // Resolve initial content once per cellId — prefer rich HTML, fall back to
  // plain text. Either form may carry raw `\f...\f*` (legacy) or footnote spans
  // (our own serialisation); prepareEditorContent normalises both into the
  // <span data-usfm-footnote> form that parses into footnote nodes.
  const initialContent = useMemo(
    () => preparedIdmlContent?.html ?? prepareEditorContent(initialHtml, initialPlain),
    [preparedIdmlContent?.html, initialHtml, initialPlain],
  )

  const isReadOnly = !editable || Boolean(heldByLabel) || Boolean(preparedIdmlContent?.error)
  const isReadOnlyRef = useRef(isReadOnly)
  useEffect(() => { isReadOnlyRef.current = isReadOnly }, [isReadOnly])

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // AQU-664: emits live text on a short debounce so terminology blots can be
  // recomputed off the live buffer, well ahead of the ~1.2s commit-idle path.
  const liveTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const presenceDraftIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSelectionKeyRef = useRef<string | null>(null)
  const lastPublishedDraftRef = useRef(initialPlain)
  const lastTypingEndedAtBoundaryRef = useRef(false)
  const lastCommittedRef = useRef<string>(initialPlain)
  // Latest typed-but-not-yet-committed snapshot. Held so the unmount cleanup
  // can flush it (navigate-away / reload during the idle window must not drop
  // the edit into the void — the commit has to reach the outbox to survive).
  const pendingCommitRef = useRef<TranslatedEditorCommit | null>(null)
  const onCommitRef = useRef(onCommit)
  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])
  // AQU-667: mirrors read by the blur handler / re-hydrate effect so both can
  // reason about "has an authoritative AI draft landed that this editor has not
  // yet absorbed?" without recreating the editor.
  const aiDraftedRef = useRef(aiDrafted)
  useEffect(() => { aiDraftedRef.current = aiDrafted }, [aiDrafted])
  const initialPlainRef = useRef(initialPlain)
  useEffect(() => { initialPlainRef.current = initialPlain }, [initialPlain])
  // The last stored value we hydrated the editor from. Declared here (not next
  // to its effect) so the blur handler can compare against it: an editor still
  // holding pre-draft text has NOT absorbed a newer authoritative value while
  // `initialPlain !== lastHydratedPlainRef`.
  const lastHydratedPlainRef = useRef(initialPlain)
  const lastHydratedContentRef = useRef(initialContent)
  const onLiveTextChangeRef = useRef(onLiveTextChange)
  useEffect(() => { onLiveTextChangeRef.current = onLiveTextChange }, [onLiveTextChange])
  const onRuleHoverRef = useRef(onRuleHover)
  useEffect(() => { onRuleHoverRef.current = onRuleHover }, [onRuleHover])
  const reportIdmlError = useCallback((message: string) => {
    setIdmlError(message)
    onIdmlValidationErrorRef.current?.(message)
  }, [])

  const snapshotEditor = useCallback((editorInstance: TiptapEditor): TranslatedEditorCommit | null => {
    const value = editorInstance.getText()
    if (!idmlContext) return { value, valueHtml: editorInstance.getHTML() }
    const valueHtml = serializeIdmlEditorDocument(editorInstance.state.doc)
    if (valueHtml === null) {
      reportIdmlError("This edit changed the protected IDML document structure. Undo it or re-import the IDML.")
      return null
    }
    const validation = validateIdmlTranslation(
      idmlContext.sourceHtml,
      valueHtml,
      idmlContext.metadata,
    )
    if (!validation.valid) {
      reportIdmlError(idmlDiagnosticMessage(validation.diagnostics[0]))
      return null
    }
    setIdmlError(null)
    onIdmlValidationErrorRef.current?.(null)
    return { value, valueHtml }
  }, [idmlContext, reportIdmlError])

  const commitEditorSnapshot = useRef<(reason?: string) => void>(() => undefined)
  // NOTE on `isDestroyed` guards here and in the effects below: `useEditor`'s
  // deps are [cellId, idmlEditorKey], so a call site that swaps cell/schema on ONE mounted
  // instance (the Media details panel) destroys the old editor while the new
  // one arrives a render later. Effects keyed on other changed deps (content,
  // readonly, direction) re-run inside that window with the stale DESTROYED
  // instance from their closure — non-null, but its view/command manager are
  // gone, so `.commands`/`.view` dereferences crash the workspace boundary.
  const applyEditorDirection = useCallback((editorInstance: TiptapEditor | null) => {
    if (!editorInstance || editorInstance.isDestroyed) return
    const next = directionModeRef.current === "auto"
      ? detectStrongTextDirection(editorInstance.getText()) ?? textDirectionRef.current
      : textDirectionRef.current
    editorInstance.view.dom.setAttribute("dir", next)
    if (lang) editorInstance.view.dom.setAttribute("lang", lang)
    else editorInstance.view.dom.removeAttribute("lang")
  }, [lang])
  const publishSelection = useCallback((editorInstance: TiptapEditor | null) => {
    if (!editorInstance || isReadOnlyRef.current) return
    const { selection, doc } = editorInstance.state
    const anchor = pmPositionToPlainPosition(doc, selection.anchor)
    const head = pmPositionToPlainPosition(doc, selection.head)
    const text = editorInstance.getText()
    const next: TargetPresenceSelection = {
      side: "target",
      anchor,
      head,
      // Oversized cells still get live caret/selection presence, but wait for
      // the durable commit before broadcasting their full text.
      ...(text.length <= MAX_PRESENCE_DRAFT_LENGTH ? { draftText: text } : {}),
    }
    const key = `${next.side}:${next.anchor}:${next.head}:${next.draftText ?? ""}`
    if (key === lastSelectionKeyRef.current) return
    lastSelectionKeyRef.current = key
    lastPublishedDraftRef.current = text
    onSelectionChangeRef.current?.(next)
  }, [])
  const scheduleSelectionPublish = useCallback((editorInstance: TiptapEditor | null) => {
    if (!editorInstance || isReadOnlyRef.current) return
    if (selectionTimerRef.current !== null) return
    selectionTimerRef.current = setTimeout(() => {
      selectionTimerRef.current = null
      // The caret offsets belong to the current draft. Until that draft has
      // passed the paused word-boundary gate, sending them would either leak
      // a partial word or position a caret against different remote text.
      if (editorInstance.getText() !== lastPublishedDraftRef.current) return
      publishSelection(editorInstance)
    }, PRESENCE_SELECTION_THROTTLE_MS)
  }, [publishSelection])
  const scheduleTypingPresencePublish = useCallback((editorInstance: TiptapEditor | null) => {
    if (!editorInstance || isReadOnlyRef.current) return
    if (presenceDraftIdleTimerRef.current !== null) {
      clearTimeout(presenceDraftIdleTimerRef.current)
    }
    presenceDraftIdleTimerRef.current = setTimeout(() => {
      presenceDraftIdleTimerRef.current = null
      const text = editorInstance.getText()
      if (!lastTypingEndedAtBoundaryRef.current) return
      if (!shouldPublishPresenceDraft(lastPublishedDraftRef.current, text)) return
      publishSelection(editorInstance)
    }, PRESENCE_DRAFT_IDLE_MS)
  }, [publishSelection])

  const editor = useEditor({
    editable: !isReadOnly,
    content: initialContent,
    extensions: [
      StarterKit.configure({
        ...(idmlContext ? { document: false } : {}),
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      // Footnotes are atomic inline nodes (selectable as one unit, like Word).
      UsfmFootnote,
      // The callback is invoked by the PM plugin, not during React render —
      // the lint rule is overly conservative here.
      createFootnoteDecorationExtension(
        () => footnoteNumberOffsetRef.current,
        () => showFootnoteTooltipsRef.current,
      ),
      createViolationDecorationExtension(() => latestViolationStateRef.current),
      createKaraokeExtension(() => latestKaraokeStateRef.current),
      ...(terminologyConcepts !== undefined
        ? [createTerminologyChipExtension(() => latestTerminologyConceptsRef.current)]
        : []),
      ...(idmlContext
        ? idmlEditorExtensions({
            context: idmlContext,
            onRejected: (diagnostic) => reportIdmlError(idmlDiagnosticMessage(diagnostic)),
          })
        : []),
    ],
    editorProps: {
      attributes: {
        // AQU-297: expose explicit textbox role + accessible label so screen
        // readers announce "GEN 1:1 — validated, editing" instead of the
        // generic ProseMirror contenteditable. The cell still holds multi-line
        // content (imported cells, deliberate Shift+Enter hard breaks), so
        // aria-multiline stays true even though plain Enter now confirms the
        // edit rather than inserting a newline (AQU-584).
        role: "textbox",
        "aria-multiline": "true",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        dir: textDirection,
        ...(lang ? { lang } : {}),
        class: cn(
          // The surrounding bg-muted well in EditorTable already reads as an
          // input, so the editor surface itself stays transparent — no flat
          // background tints competing with the recessed fill.
          // No fixed text-* class: font size inherits from the target column
          // wrapper, which carries the per-file font-size pref inline.
          compactHeight
            ? "prose prose-sm max-w-none px-1 py-0 leading-snug focus:outline-none"
            : "prose prose-sm max-w-none h-full min-h-[40px] px-1 py-0.5 leading-relaxed focus:outline-none",
          "rounded-lg transition-colors",
          className
        ),
      },
      transformPastedHTML(html: string) {
        return idmlContext ? sanitizeIdmlEditorHtml(html) : sanitizeEditorHtml(html)
      },
      handleTextInput(view, _from, _to, text) {
        if (!idmlContext) return false
        replaceIdmlSelectionWithPlainText(view, text)
        return true
      },
      handlePaste(view, event, slice) {
        if (!idmlContext) return false
        // IDML accepts only literal text and bare line breaks inside a slot.
        // Rich clipboard markup, including forged data-idml-* attributes, is
        // deliberately discarded before the transaction reaches the guards.
        const plainText = event.clipboardData?.getData("text/plain")
          ?? slice.content.textBetween(0, slice.content.size, "\n")
        event.preventDefault()
        replaceIdmlSelectionWithPlainText(view, plainText)
        return true
      },
      handleDoubleClick(view, pos, event) {
        const didSelect = selectVisibleWord(view, pos)
        if (!didSelect) return false
        event.preventDefault()
        window.requestAnimationFrame(() => {
          selectVisibleWord(view, pos)
        })
        return true
      },
      handleClick(view, pos, event) {
        if (!idmlContext) return false
        const target = event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-idml-slot]")
          : null
        const clickedSlot = target?.getAttribute("data-idml-slot")
        const requestedSlot = clickedSlot !== null && clickedSlot !== undefined
          ? Number(clickedSlot)
          : undefined
        const selectedSlot = view.state.selection.$from.parent.type.name === "idmlSlot"
          ? Number(view.state.selection.$from.parent.attrs.slot)
          : undefined
        if (
          requestedSlot !== undefined
          && requestedSlot === selectedSlot
          && isEditableIdmlSelection(view.state.selection)
        ) return false
        const resolvedClick = view.state.doc.resolve(pos)
        const position = (
          Number.isSafeInteger(requestedSlot)
          && resolvedClick.parent.type.name === "idmlSlot"
          && Number(resolvedClick.parent.attrs.slot) === requestedSlot
          && resolvedClick.parent.attrs.editable === true
        )
          ? pos
          : idmlEditableSlotPosition(
              view.state.doc,
              Number.isSafeInteger(requestedSlot) ? requestedSlot : undefined,
              "end",
            )
        if (position === null) return false
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, position))
            .scrollIntoView(),
        )
        view.focus()
        event.preventDefault()
        return true
      },
      handleDOMEvents: {
        click(view, event) {
          if (!idmlContext) return false
          const target = event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>("[data-idml-slot]")
            : null
          if (!target || target.textContent !== "") return false
          const requestedSlot = Number(target.getAttribute("data-idml-slot"))
          const position = idmlEditableSlotPosition(
            view.state.doc,
            Number.isSafeInteger(requestedSlot) ? requestedSlot : undefined,
          )
          if (position === null) return true
          event.preventDefault()
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, position))
              .scrollIntoView(),
          )
          view.focus()
          return true
        },
        compositionstart(view) {
          if (!idmlContext) return false
          const selection = view.state.selection
          const position = idmlEditableSlotPosition(view.state.doc)
          idmlCompositionRangeRef.current = isEditableIdmlSelection(selection)
            ? { from: selection.from, to: selection.to }
            : position === null
              ? null
              : { from: position, to: position }
          return false
        },
        beforeinput(view, event) {
          if (!idmlContext) return false
          const inputEvent = event as InputEvent
          if (inputEvent.inputType !== "insertCompositionText") return false
          inputEvent.preventDefault()
          const range = replaceIdmlSelectionWithPlainText(
            view,
            inputEvent.data ?? "",
            idmlCompositionRangeRef.current ?? undefined,
          )
          idmlCompositionRangeRef.current = range
          return true
        },
        compositionend() {
          idmlCompositionRangeRef.current = null
          return false
        },
        mouseover(view, event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>(".usfm-footnote-marker")
          if (marker && view.dom.contains(marker)) {
            const index = Number(marker.dataset.footnoteIndex)
            onFootnoteHoverRef.current?.(Number.isFinite(index) ? index : null)
            return false
          }
          // AQU-664: hovering a violation blot previews its rule explanation.
          const blot = target?.closest<HTMLElement>("[data-rule-id]")
          if (blot && view.dom.contains(blot)) {
            onRuleHoverRef.current?.(blot.getAttribute("data-rule-id"), blot)
          }
          return false
        },
        mouseout(view, event) {
          const target = event.target as HTMLElement | null
          const blot = target?.closest<HTMLElement>("[data-rule-id]")
          if (blot && view.dom.contains(blot)) {
            // AQU-664: dismiss the explanation once the pointer leaves the blot
            // (ignore moves within the same blot's own children).
            const related = event.relatedTarget as HTMLElement | null
            if (!related || !blot.contains(related)) onRuleHoverRef.current?.(null, null)
          }
          const marker = target?.closest<HTMLElement>(".usfm-footnote-marker")
          if (!marker || !view.dom.contains(marker)) return false
          const related = event.relatedTarget as HTMLElement | null
          if (related && marker.contains(related)) return false
          onFootnoteHoverRef.current?.(null)
          return false
        },
        focusin(view, event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>(".usfm-footnote-marker")
          if (!marker || !view.dom.contains(marker)) return false
          const index = Number(marker.dataset.footnoteIndex)
          onFootnoteHoverRef.current?.(Number.isFinite(index) ? index : null)
          return false
        },
        focusout(view, event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>(".usfm-footnote-marker")
          if (!marker || !view.dom.contains(marker)) return false
          onFootnoteHoverRef.current?.(null)
          return false
        },
        dblclick(view, event) {
          const mouseEvent = event as MouseEvent
          const position = view.posAtCoords({
            left: mouseEvent.clientX,
            top: mouseEvent.clientY,
          })
          if (!position) return false
          const didSelect = selectVisibleWord(view, position.pos)
          if (!didSelect) return false
          mouseEvent.preventDefault()
          window.requestAnimationFrame(() => {
            selectVisibleWord(view, position.pos)
          })
          return true
        },
      },
      // Cell navigation. Tab/Shift+Tab always step cells; Up/Down step cells
      // only at the first/last visual line so the caret can still move between
      // wrapped lines within a multi-line cell. Left/Right are untouched.
      // AQU-297: Escape commits pending work (via blur) and signals the parent
      // to return keyboard focus to the grid-row wrapper, exiting edit mode.
      handleKeyDown(view, event) {
        // AQU-297: Esc — commit-and-exit back to grid focus.
        if (event.key === "Escape") {
          event.preventDefault()
          // Blur the editor — this triggers the onBlur commit path so any
          // pending idle edits are flushed before focus moves to the row.
          view.dom.blur()
          onEscapeToGridRef.current?.()
          return true
        }
        if (
          idmlContext
          && event.key.length === 1
          && !event.metaKey
          && !event.altKey
          && !event.ctrlKey
          && !event.isComposing
        ) {
          event.preventDefault()
          replaceIdmlSelectionWithPlainText(view, event.key)
          return true
        }
        const plain = !event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey
        // An IDML cell represents exactly one InDesign paragraph. Both Enter
        // variants add a line break inside the current protected text slot;
        // neither may create another ProseMirror/InDesign paragraph.
        if (
          idmlContext
          && event.key === "Enter"
          && !event.metaKey
          && !event.altKey
          && !event.ctrlKey
        ) {
          event.preventDefault()
          const { selection, schema } = view.state
          const hardBreak = schema.nodes.hardBreak
          if (
            hardBreak
            && selection.$from.sameParent(selection.$to)
            && selection.$from.parent.type.name === "idmlSlot"
          ) {
            view.dispatch(
              view.state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView(),
            )
          } else {
            reportIdmlError("Place the caret inside an InDesign text slot before adding a line break.")
          }
          return true
        }
        // AQU-584: plain Enter confirms the edit. Left to StarterKit's default,
        // Enter split the paragraph and left a trailing newline inside the cell
        // (the caret stayed put), which serialized to plain text with an extra
        // "\n" and tripped the "extra white space" QA rule. Intercept it to
        // commit-and-exit to the grid — the same path as Escape (blur flushes
        // the pending idle commit; the parent returns focus to the row). A
        // deliberate line break is still available via Shift+Enter (hard break).
        if (plain && event.key === "Enter") {
          event.preventDefault()
          view.dom.blur()
          onEscapeToGridRef.current?.()
          return true
        }
        if (plain && (event.key === "Backspace" || event.key === "Delete")) {
          const target = findFootnoteDeleteTarget(view, event.key, footnoteNumberOffsetRef.current)
          if (target) {
            event.preventDefault()
            const pending = pendingFootnoteDeleteRef.current
            if (pending?.index === target.index) {
              if (deleteFootnoteByIndex(view, target.index, footnoteNumberOffsetRef.current)) {
                setPendingFootnoteDelete(null)
                commitEditorSnapshot.current("footnote-delete")
              }
              return true
            }
            setPendingFootnoteDelete({ index: target.index, label: target.label })
            return true
          }
        } else if (pendingFootnoteDeleteRef.current) {
          setPendingFootnoteDelete(null)
        }
        // Shift+Arrow in a footnote-containing cell: drive the selection
        // ourselves. Real Safari's native keyboard selection extension across
        // contenteditable=false inline atoms is unreliable (it flips the
        // anchor / paints a split, ballooned selection — the bug seen on
        // Safari but not Chromium, and not reproducible via WebDriver synthetic
        // keys). By intercepting the key, preventing the default, and setting a
        // deterministic TextSelection, native Safari selection never runs, so
        // it can't corrupt the range. This pairs with two other fixes: the
        // marker is not focusable (no tabIndex focus-steal) and the footnote
        // decoration set is not rebuilt on selection change (no mid-selection
        // DOM churn). Ordinary cells (no footnote) keep native selection.
        const shiftArrow = event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey
        if (shiftArrow && event.key === "ArrowLeft" && extendSelectionAcrossFootnote(view, "left")) {
          event.preventDefault()
          return true
        }
        if (shiftArrow && event.key === "ArrowRight" && extendSelectionAcrossFootnote(view, "right")) {
          event.preventDefault()
          return true
        }
        const navigate = onNavigateCellRef.current
        if (!navigate) return false
        if (event.key === "Tab") {
          event.preventDefault()
          navigate(event.shiftKey ? "prev" : "next")
          return true
        }
        if (plain && event.key === "ArrowUp" && view.endOfTextblock("up")) {
          event.preventDefault()
          navigate("prev")
          return true
        }
        if (plain && event.key === "ArrowDown" && view.endOfTextblock("down")) {
          event.preventDefault()
          navigate("next")
          return true
        }
        return false
      },
    },
    onUpdate({ editor }) {
      applyEditorDirection(editor)
      const { selection, doc } = editor.state
      const caretOffset = pmPositionToPlainPosition(doc, selection.head)
      lastTypingEndedAtBoundaryRef.current = isPresenceWordBoundary(editor.getText(), caretOffset)
      scheduleTypingPresencePublish(editor)
      // Reset idle timer on every keystroke; commit when the user pauses.
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
      const snapshot = snapshotEditor(editor)
      if (!snapshot) {
        pendingCommitRef.current = null
        return
      }
      const { value: text, valueHtml: html } = snapshot
      pendingCommitRef.current = snapshot
      idleTimerRef.current = setTimeout(() => {
        pendingCommitRef.current = null
        if (text === lastCommittedRef.current) return
        lastCommittedRef.current = text
        onCommitRef.current({ value: text, valueHtml: html })
      }, COMMIT_IDLE_MS)
      // AQU-664: publish the live buffer on a much shorter debounce so the
      // caller can recompute terminology blots off it, well before the commit.
      if (onLiveTextChangeRef.current) {
        if (liveTextTimerRef.current !== null) clearTimeout(liveTextTimerRef.current)
        liveTextTimerRef.current = setTimeout(() => {
          onLiveTextChangeRef.current?.(text)
        }, LIVE_CHECK_MS)
      }
    },
    onSelectionUpdate({ editor, transaction }) {
      // A typing transaction also moves the caret; onUpdate owns its batched
      // draft publication. Pointer/arrow selection changes remain responsive.
      if (transaction.docChanged) return
      scheduleSelectionPublish(editor)
    },
    onFocus({ editor }) {
      applyEditorDirection(editor)
      if (idmlContext && !isEditableIdmlSelection(editor.state.selection)) {
        // Read-view activation mounts a fresh editor after the original click,
        // so there is no pointer position to preserve. Use ProseMirror's real
        // end-of-slot position: populated targets append where users expect,
        // while empty slots have the same start/end and avoid the browser's
        // phantom trailing <br> selection.
        const position = idmlEditableSlotPosition(editor.state.doc, undefined, "end")
        if (position !== null) editor.commands.setTextSelection(position)
      }
      onFocus?.()
      publishSelection(editor)
    },
    onBlur({ editor }) {
      if (selectionTimerRef.current !== null) {
        clearTimeout(selectionTimerRef.current)
        selectionTimerRef.current = null
      }
      if (presenceDraftIdleTimerRef.current !== null) {
        clearTimeout(presenceDraftIdleTimerRef.current)
        presenceDraftIdleTimerRef.current = null
      }
      lastSelectionKeyRef.current = null
      onSelectionChangeRef.current?.(null)
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      // AQU-664: flush the live buffer immediately on blur (so the blot tracks
      // the final text without waiting on the debounce) and dismiss any hover
      // explanation the pointer left behind.
      if (liveTextTimerRef.current !== null) {
        clearTimeout(liveTextTimerRef.current)
        liveTextTimerRef.current = null
      }
      onLiveTextChangeRef.current?.(editor.getText())
      onRuleHoverRef.current?.(null, null)
      const snapshot = snapshotEditor(editor)
      pendingCommitRef.current = null
      if (!snapshot) {
        onBlur?.()
        return
      }
      const { value: text, valueHtml: html } = snapshot
      // AQU-667 invariant: a blur must never commit text older than the newest
      // authoritative draft for this cell. If an AI draft is pending in the
      // store that this editor has not yet absorbed (its value differs from what
      // we last hydrated) and the editor still holds the pre-draft text,
      // committing here would chain a stale/blank revert onto the draft — the
      // sparkle/batch prediction "randomly doesn't save". Skip: the draft is
      // already durable in the store + outbox and the re-hydrate effect absorbs
      // it on the next render.
      const hasUnabsorbedDraft =
        aiDraftedRef.current &&
        initialPlainRef.current !== lastHydratedPlainRef.current &&
        text !== initialPlainRef.current
      if (!hasUnabsorbedDraft && text !== lastCommittedRef.current) {
        lastCommittedRef.current = text
        onCommitRef.current({ value: text, valueHtml: html })
      }
      onBlur?.()
    },
  }, [cellId, idmlEditorKey])

  useEffect(() => {
    applyEditorDirection(editor)
  }, [applyEditorDirection, editor, textDirection, directionMode])

  useEffect(() => {
    return () => {
      if (selectionTimerRef.current !== null) {
        clearTimeout(selectionTimerRef.current)
        selectionTimerRef.current = null
      }
      if (presenceDraftIdleTimerRef.current !== null) {
        clearTimeout(presenceDraftIdleTimerRef.current)
        presenceDraftIdleTimerRef.current = null
      }
      if (liveTextTimerRef.current !== null) {
        clearTimeout(liveTextTimerRef.current)
        liveTextTimerRef.current = null
      }
      lastSelectionKeyRef.current = null
      onSelectionChangeRef.current?.(null)
    }
  }, [])

  commitEditorSnapshot.current = () => {
    if (!editor) return
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    const snapshot = snapshotEditor(editor)
    pendingCommitRef.current = null
    if (!snapshot) return
    const { value: text, valueHtml: html } = snapshot
    if (text !== lastCommittedRef.current) {
      lastCommittedRef.current = text
      onCommitRef.current({ value: text, valueHtml: html })
    }
  }

  const confirmPendingFootnoteDelete = useCallback(() => {
    if (!editor || isReadOnly) return
    const pending = pendingFootnoteDeleteRef.current
    if (!pending) return
    if (deleteFootnoteByIndex(editor.view, pending.index, footnoteNumberOffsetRef.current)) {
      setPendingFootnoteDelete(null)
      commitEditorSnapshot.current("footnote-delete")
      editor.commands.focus()
    }
  }, [editor, isReadOnly])

  const cancelPendingFootnoteDelete = useCallback(() => {
    setPendingFootnoteDelete(null)
    editor?.commands.focus()
  }, [editor])

  useImperativeHandle(ref, () => ({
    getFootnoteInsertionAnchor() {
      if (!editor || isReadOnly) return null
      const { state } = editor
      if (!editor.isFocused) {
        return withFootnotePreview(state.doc, {
          position: getDocumentEndPosition(state.doc),
          from: getDocumentEndPosition(state.doc),
          to: getDocumentEndPosition(state.doc),
          plainPosition: getDocumentPlainText(state.doc).length,
          source: "end",
          previewText: getDocumentEndPreview(state.doc),
        })
      }
      const { from, to, empty } = state.selection
      if (!empty) {
        return withFootnotePreview(state.doc, {
          position: to,
          from,
          to,
          plainPosition: pmPositionToPlainPosition(state.doc, to),
          source: "selection",
          previewText: state.doc.textBetween(from, to, "", ""),
        })
      }
      const wordAnchor = getWordAnchor(state.doc, from)
      if (wordAnchor) return withFootnotePreview(state.doc, wordAnchor)
      return withFootnotePreview(state.doc, {
        position: from,
        from,
        to: from,
        plainPosition: pmPositionToPlainPosition(state.doc, from),
        source: "cursor",
        previewText: "Cursor position",
      })
    },
    insertFootnoteMarker(marker, anchor, anchorText) {
      if (!editor || isReadOnly) return false
      const fallbackPosition = getDocumentEndPosition(editor.state.doc)
      const fallback = {
        position: fallbackPosition,
        from: fallbackPosition,
        to: fallbackPosition,
        plainPosition: getDocumentPlainText(editor.state.doc).length,
        source: "end",
      } satisfies FootnoteInsertionAnchor
      const insertion = anchor ?? fallback
      const maxPosition = Math.max(1, editor.state.doc.content.size - 1)
      const shouldReplaceAnchor = anchorText !== undefined && insertion.from !== insertion.to
      const includeText = anchorText !== undefined && anchorText.length > 0
      const content = [
        ...(includeText ? [{ type: "text", text: anchorText as string }] : []),
        { type: FOOTNOTE_NODE_NAME, attrs: { raw: marker } },
      ]
      const inserted = shouldReplaceAnchor
        ? editor.commands.insertContentAt({
          from: Math.max(1, Math.min(insertion.from, maxPosition)),
          to: Math.max(1, Math.min(insertion.to, maxPosition)),
        }, content, { updateSelection: false })
        : editor.commands.insertContentAt(
          Math.max(1, Math.min(insertion.position, maxPosition)),
          content,
          { updateSelection: false },
        )
      if (!inserted) return false
      commitEditorSnapshot.current("footnote")
      return true
    },
  }), [editor, isReadOnly])

  // The committed baseline is the editor's OWN canonical text, never the raw
  // stored value. Stored values can be HTML-escaped or otherwise differ from
  // what TipTap parses + serializes — legacy-import wrote `--&gt;`, which
  // hydrates as `-->`. Comparing editor.getText() against the raw `initialPlain`
  // would misread that load-time normalization as a user edit and emit a
  // phantom revision on the next blur, corrupting files just by opening them.
  // Seed once per editor instance (one editor per cellId). (AQU-216)
  // (`lastHydratedPlainRef` is declared above so the blur handler can read it.)
  useEffect(() => {
    if (!editor) return
    lastCommittedRef.current = editor.getText()
    lastHydratedPlainRef.current = initialPlain
    lastHydratedContentRef.current = initialContent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Re-hydrate only when the stored value genuinely changes — keyed on the raw
  // `initialPlain` so an escaping-only difference never forces a reload.
  //
  // We normally never overwrite a focused editor — that's what the banner is
  // for. AQU-667 EXCEPTION: an authoritative AI draft (sparkle / batch "Draft
  // all") can land on this cell *while it is focused*. That draft lives in the
  // store but is invisible inside the editor, and a later blur would commit the
  // editor's stale pre-draft text over it (the prediction "randomly doesn't
  // save"). So when the incoming value is an AI draft, absorb it even while
  // focused, caret to end so the next keystroke edits the prediction — not the
  // pre-prediction text. `aiDrafted` is the gate: a human's own in-flight edit
  // commits with `aiDrafted=false`, so live typing is never yanked out.
  useEffect(() => {
    // isDestroyed: see applyEditorDirection — a stale destroyed instance can
    // reach this effect when initialPlain changes during an in-place cellId
    // swap. Skip it; the replacement editor is created with the new
    // initialContent and this effect re-runs when its identity lands.
    if (!editor || editor.isDestroyed) return
    if (
      initialPlain === lastHydratedPlainRef.current
      && (!idmlContext || initialContent === lastHydratedContentRef.current)
    ) return
    if (editor.isFocused && !aiDrafted) return
    const wasFocused = editor.isFocused
    lastHydratedPlainRef.current = initialPlain
    lastHydratedContentRef.current = initialContent
    editor.commands.setContent(initialContent)
    // Our own hydration must not schedule a phantom commit: clear any idle timer
    // / pending snapshot the setContent onUpdate may have armed, so a stray
    // commit can't fire the just-absorbed value back through the write path.
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    pendingCommitRef.current = null
    if (wasFocused) editor.commands.focus("end")
    lastCommittedRef.current = editor.getText()
  }, [editor, initialContent, initialPlain, aiDrafted, idmlContext])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!isReadOnly)
  }, [editor, isReadOnly])

  const [, forceEditorStateUpdate] = useState(0)
  useEffect(() => {
    if (!editor) return
    const refresh = ({ transaction }: { transaction?: Transaction } = {}) => {
      if (transaction && !transaction.docChanged && !transaction.selectionSet) return
      forceEditorStateUpdate((n) => (n + 1) % 1_000_000)
    }
    editor.on("transaction", refresh)
    editor.on("selectionUpdate", refresh)
    return () => {
      editor.off("transaction", refresh)
      editor.off("selectionUpdate", refresh)
    }
  }, [editor])

  const handleEditorKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return
    const target = event.target as HTMLElement | null
    if (!target?.closest(".ProseMirror")) return
    const navigate = onNavigateCellRef.current
    if (!navigate) return
    event.preventDefault()
    event.stopPropagation()
    navigate(event.shiftKey ? "prev" : "next")
  }, [])

  const handleFormattingToolbarMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
  }, [])

  useEffect(() => {
    latestViolationStateRef.current = {
      infractions: infractions ?? [],
      ruleSeverity: ruleSeverity ?? new Map<string, "major" | "minor">(),
      waivedRuleIds: waivedRuleIds ?? new Set<string>(),
    }
    if (editor) {
      const tr = editor.state.tr.setMeta(violationPluginKey, "rebuild")
      editor.view.dispatch(tr)
    }
  }, [editor, infractions, ruleSeverity, waivedRuleIds])

  useEffect(() => {
    latestKaraokeStateRef.current = {
      ...latestKaraokeStateRef.current,
      timings: audioTimings,
      onSeekToWord: onSeekToTime ? (_, timing) => onSeekToTime(timing.t0) : undefined,
    }
    if (editor) {
      editor.view.dispatch(editor.state.tr.setMeta(karaokePluginKey, "rebuild"))
    }
  }, [editor, audioTimings, onSeekToTime])

  useEffect(() => {
    latestTerminologyConceptsRef.current = terminologyConcepts ?? []
    if (editor && terminologyConcepts !== undefined) {
      editor.view.dispatch(editor.state.tr.setMeta(terminologyChipPluginKey, "rebuild"))
    }
  }, [editor, terminologyConcepts])

  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(footnoteDecorationPluginKey, "rebuild"))
  }, [editor, footnoteNumberOffset, showFootnoteTooltips])

  const lastActiveIdxRef = useRef(-1)
  useEffect(() => {
    if (!editor) return
    const idx = findActiveTimingIndex(audioTimings, audioCurrentTime ?? 0)
    if (idx === lastActiveIdxRef.current) return
    lastActiveIdxRef.current = idx
    latestKaraokeStateRef.current = { ...latestKaraokeStateRef.current, activeIdx: idx }
    editor.view.dispatch(editor.state.tr.setMeta(karaokePluginKey, "rebuild"))
  }, [editor, audioTimings, audioCurrentTime])

  // Flush the pending idle commit on unmount so a programmatic navigate-away
  // (file/tab switch, route change) doesn't drop work still inside the 1.2s
  // idle window. The commit lands in the outbox (AD-3) and reconciles from
  // there; without this it was silently discarded.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      const pending = pendingCommitRef.current
      pendingCommitRef.current = null
      if (pending && pending.value !== lastCommittedRef.current) {
        lastCommittedRef.current = pending.value
        onCommitRef.current(pending)
      }
    }
  }, [])

  if (!editor) {
    return (
      <div className={cn("min-h-[40px] px-2 py-1 text-muted-foreground", className)}>
        {placeholder}
      </div>
    )
  }

  return (
    <div className={cn("relative", compactHeight ? "" : "h-full")}>
      {remoteChangedDuringEdit && onDiscardLocal && (
        <div className="mb-1 flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <span>This cell changed elsewhere while you were editing.</span>
          <button
            type="button"
            onClick={onDiscardLocal}
            className="rounded-full bg-amber-500/20 px-2 py-0.5 text-amber-900 hover:bg-amber-500/30 dark:text-amber-100"
          >
            Discard and reload
          </button>
        </div>
      )}
      {pendingFootnoteDelete && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-2 rounded-lg border border-destructive/20 bg-background px-2 py-1 text-[11px]">
          <span className="text-muted-foreground">
            Delete footnote {pendingFootnoteDelete.label}?
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={confirmPendingFootnoteDelete}
            className="rounded px-2 py-0.5 font-medium text-destructive hover:bg-destructive/10"
          >
            I'm sure
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelPendingFootnoteDelete}
            className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      )}
      {!idmlConfiguration && <BubbleMenu
        editor={editor}
        shouldShow={({ editor, from, to }) => editor.isFocused && from !== to}
        options={{ placement: "top" }}
      >
        <div
          data-testid="formatting-bubble-menu"
          className="relative z-40 flex gap-0.5 rounded-lg bg-card p-0.5"
          onMouseDown={handleFormattingToolbarMouseDown}
        >
          <AppTooltip content="Bold (Cmd+B)">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => editor.chain().focus().toggleBold().run()}
              aria-label="Bold"
              className={cn("rounded-full", editor.isActive("bold") && "bg-accent")}
            >
              <Bold className="h-3 w-3" />
            </Button>
          </AppTooltip>
          <AppTooltip content="Italic (Cmd+I)">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => editor.chain().focus().toggleItalic().run()}
              aria-label="Italic"
              className={cn("rounded-full", editor.isActive("italic") && "bg-accent")}
            >
              <Italic className="h-3 w-3" />
            </Button>
          </AppTooltip>
          <AppTooltip content="Underline (Cmd+U)">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              aria-label="Underline"
              className={cn("rounded-full", editor.isActive("underline") && "bg-accent")}
            >
              <UnderlineIcon className="h-3 w-3" />
            </Button>
          </AppTooltip>
          <AppTooltip content="Strikethrough">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => editor.chain().focus().toggleStrike().run()}
              aria-label="Strikethrough"
              className={cn("rounded-full", editor.isActive("strike") && "bg-accent")}
            >
              <Strikethrough className="h-3 w-3" />
            </Button>
          </AppTooltip>
          <AppTooltip content="Inline code">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => editor.chain().focus().toggleCode().run()}
              aria-label="Inline code"
              className={cn("rounded-full", editor.isActive("code") && "bg-accent")}
            >
              <Code className="h-3 w-3" />
            </Button>
          </AppTooltip>
        </div>
      </BubbleMenu>}
      {idmlError && (
        <div
          role="alert"
          className="mb-1 rounded-lg border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive"
        >
          {idmlError}
        </div>
      )}
      <div
        className={cn(compactHeight ? "" : "h-full")}
        onKeyDownCapture={handleEditorKeyDownCapture}
        onClick={(e) => {
          const target = e.target as HTMLElement
          // AQU-204: term chip click → open TermLookupPopover via caller
          if (onTermChipClick) {
            const chip = target.closest(".term-chip[data-source-term]")
            if (chip) {
              const term = chip.getAttribute("data-source-term")
              if (term) {
                onTermChipClick(term, chip as HTMLElement)
                return
              }
            }
          }
          if (!onRuleClick) return
          const blot = target.closest("[data-rule-id]")
          if (blot) {
            onRuleClick(blot.getAttribute("data-rule-id")!, blot as HTMLElement)
          }
        }}
      >
        <EditorContent
          editor={editor}
          className={cn(compactHeight ? "" : "h-full [&>.ProseMirror]:h-full")}
        />
      </div>
    </div>
  )
})

function getDocumentEndPosition(doc: ProseMirrorNode): number {
  return Math.max(1, doc.content.size - 1)
}

function docContainsFootnote(doc: ProseMirrorNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (node.type.name === FOOTNOTE_NODE_NAME) {
      found = true
      return false
    }
    return true
  })
  return found
}

// Deterministic horizontal Shift+Arrow for cells that contain footnotes. We
// step one position (one char, or the whole footnote atom when the neighbour is
// a footnote) and dispatch the extended TextSelection ourselves, so real
// Safari's unreliable native selection extension across contenteditable=false
// atoms never runs. Returns false (letting native handle it) when there is no
// footnote in the cell, so ordinary cells keep grapheme-aware native selection.
function extendSelectionAcrossFootnote(view: EditorView, direction: "left" | "right"): boolean {
  const { selection, doc } = view.state
  if (!docContainsFootnote(doc)) return false

  const head = selection.head
  const $head = doc.resolve(head)
  const neighbour = direction === "left" ? $head.nodeBefore : $head.nodeAfter
  const step = neighbour && neighbour.type.name === FOOTNOTE_NODE_NAME ? neighbour.nodeSize : 1
  const min = 1
  const max = Math.max(1, doc.content.size - 1)
  const newHead = direction === "left"
    ? Math.max(min, head - step)
    : Math.min(max, head + step)
  if (newHead === head) return false

  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(doc, selection.anchor, newHead))
      .scrollIntoView(),
  )
  return true
}

function findFootnoteDeleteTarget(
  view: EditorView,
  key: "Backspace" | "Delete",
  numberOffset: number,
): (PendingFootnoteDelete & { from: number; to: number }) | null {
  const { selection, doc } = view.state
  // Range selections delete the whole range (footnote nodes go with it cleanly,
  // since they're atomic) — only guard caret-adjacent single-press deletes.
  if (!selection.empty) return null
  const ranges = getFootnotePmTargets(doc, numberOffset)
  const pos = selection.from
  return ranges.find((range) => (
    key === "Backspace"
      ? pos > range.from && pos <= range.to
      : pos >= range.from && pos < range.to
  )) ?? null
}

function deleteFootnoteByIndex(view: EditorView, index: number, numberOffset: number): boolean {
  const target = getFootnotePmTargets(view.state.doc, numberOffset).find((range) => range.index === index)
  if (!target) return false
  view.dispatch(view.state.tr.delete(target.from, target.to).scrollIntoView())
  return true
}

function selectVisibleWord(view: EditorView, position: number): boolean {
  const selection = findVisibleWordSelection(view.state.doc, position)
  if (!selection) return false
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, selection.from, selection.to))
      .scrollIntoView(),
  )
  return true
}

function findVisibleWordSelection(
  doc: ProseMirrorNode,
  position: number,
): { from: number; to: number } | null {
  const map = buildUsfmPlainTextMap(doc)
  if (!map.text) return null
  const footnotes = extractUsfmFootnotes(map.text)
  const hiddenRanges = footnotes.map((footnote) => ({
    from: footnote.index,
    to: footnote.index + footnote.raw.length,
  }))
  const isHidden = (offset: number) => hiddenRanges.some((range) => offset >= range.from && offset < range.to)
  const hiddenAtPosition = hiddenRanges.find((range) => {
    const plain = pmToPlainOffset(doc, position)
    return plain >= range.from && plain <= range.to
  })

  let plainPosition = pmToPlainOffset(doc, position)
  if (hiddenAtPosition) plainPosition = Math.max(0, hiddenAtPosition.from - 1)
  if (!isWordChar(map.text[plainPosition] ?? "") && plainPosition > 0 && isWordChar(map.text[plainPosition - 1] ?? "")) {
    plainPosition -= 1
  }
  if (!isWordChar(map.text[plainPosition] ?? "") || isHidden(plainPosition)) return null

  let start = plainPosition
  while (start > 0 && !isHidden(start - 1) && isWordChar(map.text[start - 1] ?? "")) {
    start -= 1
  }
  let end = plainPosition + 1
  while (end < map.text.length && !isHidden(end) && isWordChar(map.text[end] ?? "")) {
    end += 1
  }

  const from = map.plainToPm[start]
  const to = map.plainToPm[end]
  if (from === undefined || to === undefined || from >= to) return null
  return { from, to }
}

function getFootnotePmTargets(
  doc: ProseMirrorNode,
  numberOffset: number,
): Array<PendingFootnoteDelete & { from: number; to: number }> {
  const targets: Array<PendingFootnoteDelete & { from: number; to: number }> = []
  let ordinal = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_NODE_NAME) return true
    const parsed = extractUsfmFootnotes((node.attrs.raw as string) ?? "")[0]
    targets.push({
      index: ordinal,
      label: footnoteTargetLabel(parsed?.caller ?? "", ordinal, numberOffset),
      from: pos,
      to: pos + node.nodeSize,
    })
    ordinal += 1
    return false
  })
  return targets
}

function footnoteTargetLabel(caller: string, index: number, numberOffset: number): string {
  const trimmed = caller.trim()
  if (trimmed && trimmed !== "+" && trimmed !== "-") return trimmed
  return String(numberOffset + index + 1)
}

function isWordChar(value: string): boolean {
  return /^[\p{L}\p{N}'’-]$/u.test(value)
}

function getWordAnchor(
  doc: ProseMirrorNode,
  position: number,
): FootnoteInsertionAnchor | null {
  // Work in plain-text space (footnote nodes expand to their raw `\f...\f*`) so
  // the word boundaries — and the bail-out when the caret sits on footnote
  // syntax — stay correct even with footnotes earlier in the same paragraph.
  const { text, plainToPm } = buildUsfmPlainTextMap(doc)
  const offset = pmToPlainOffset(doc, position)
  if (
    offset >= text.length ||
    /\s/.test(text[offset] ?? "") ||
    isFootnoteSyntaxAtOffset(text, offset)
  ) {
    return null
  }

  let start = offset
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1
  let end = offset
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1

  const candidate = text.slice(start, end)
  if (candidate.includes("\\") || /^f\*?$/.test(candidate)) return null

  const from = plainToPm[start]
  const to = plainToPm[end]
  if (from === undefined || to === undefined) return null
  return {
    position: to,
    from,
    to,
    plainPosition: end,
    source: "word",
    previewText: candidate,
  }
}

function isFootnoteSyntaxAtOffset(text: string, offset: number): boolean {
  if (text[offset] === "\\") return true
  const before = text.slice(Math.max(0, offset - 8), offset)
  return /\\$/.test(before) || /\\f\s*$/.test(before)
}

function getDocumentEndPreview(doc: ProseMirrorNode): string {
  const text = normalizeAnchorPreview(doc.textBetween(0, doc.content.size, " ", " "))
  if (!text) return "End of cell"
  const words = text.split(/\s+/)
  return words.slice(Math.max(0, words.length - 6)).join(" ")
}

function withFootnotePreview(
  doc: ProseMirrorNode,
  anchor: FootnoteInsertionAnchor,
): FootnoteInsertionAnchor {
  const text = getDocumentPlainText(doc)
  const plainPosition = Math.max(0, Math.min(anchor.plainPosition, text.length))
  return {
    ...anchor,
    plainPosition,
    previewBefore: text.slice(0, plainPosition),
    previewAfter: text.slice(plainPosition),
  }
}

function getDocumentPlainText(doc: ProseMirrorNode): string {
  return buildUsfmPlainTextMap(doc).text
}

function pmPositionToPlainPosition(doc: ProseMirrorNode, position: number): number {
  return pmToPlainOffset(doc, position)
}

function normalizeAnchorPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 80) return normalized
  return `${normalized.slice(0, 77).trimEnd()}...`
}
