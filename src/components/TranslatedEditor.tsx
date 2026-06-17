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
// and passes `heldByLabel` here. When that's set the editor is read-only
// and shows the "Alice is editing" affordance.

import { useEditor, EditorContent } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import StarterKit from "@tiptap/starter-kit"
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import type { RuleInfraction } from "@/lib/parsers/types"
import { createViolationDecorationExtension, violationPluginKey } from "@/lib/richtext/violation-decoration-plugin"
import { createKaraokeExtension, karaokePluginKey, type KaraokePluginState } from "@/lib/richtext/karaoke-plugin"
import { createTerminologyChipExtension, terminologyChipPluginKey } from "@/lib/richtext/terminology-chip-plugin"
import { createFootnoteDecorationExtension, footnoteDecorationPluginKey } from "@/lib/richtext/footnote-decoration-plugin"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import type { Concept } from "@/lib/terminology/types"
import { findActiveTimingIndex } from "@/lib/audio/timings"
import type { WordTiming } from "@/lib/codex-editor/types"

/** Window before a quiet keystroke pause counts as a commit-worthy idle. */
export const COMMIT_IDLE_MS = 1_200

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
  onCommit: (snapshot: TranslatedEditorCommit) => void
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  compactHeight?: boolean
  editable?: boolean
  /** "Alice is editing" — when present, the editor is read-only and the banner shows. */
  heldByLabel?: string | null
  infractions?: RuleInfraction[]
  ruleSeverity?: Map<string, "major" | "minor">
  waivedRuleIds?: Set<string>
  onRuleClick?: (ruleId: string, anchor: HTMLElement) => void
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
   * Chip click exposes `data-source-term` for FRO-204 (TermLookupPopover).
   */
  terminologyConcepts?: Concept[]
  /**
   * FRO-204: Called when the user clicks a term chip in the editor.
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
   * FRO-297: Accessible label for the target editor textbox.
   * Should include the cell reference and validation state,
   * e.g. "GEN 1:1 — validated". Announced by screen readers.
   */
  ariaLabel?: string
  /**
   * FRO-297: Called when the user presses Escape while editing.
   * The editor commits any pending changes (via blur) and signals
   * the parent to return focus to the grid row wrapper.
   */
  onEscapeToGrid?: () => void
}

export const TranslatedEditor = forwardRef<TranslatedEditorHandle, TranslatedEditorProps>(function TranslatedEditor({
  cellId,
  initialHtml,
  initialPlain,
  onCommit,
  onFocus,
  onBlur,
  placeholder,
  className,
  compactHeight = false,
  editable = true,
  heldByLabel,
  infractions,
  ruleSeverity,
  waivedRuleIds,
  onRuleClick,
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
  const footnoteNumberOffsetRef = useRef(footnoteNumberOffset)
  useEffect(() => { footnoteNumberOffsetRef.current = footnoteNumberOffset }, [footnoteNumberOffset])
  const showFootnoteTooltipsRef = useRef(showFootnoteTooltips)
  useEffect(() => { showFootnoteTooltipsRef.current = showFootnoteTooltips }, [showFootnoteTooltips])
  const onFootnoteHoverRef = useRef(onFootnoteHover)
  useEffect(() => { onFootnoteHoverRef.current = onFootnoteHover }, [onFootnoteHover])
  const [pendingFootnoteDelete, setPendingFootnoteDelete] = useState<PendingFootnoteDelete | null>(null)
  const pendingFootnoteDeleteRef = useRef<PendingFootnoteDelete | null>(null)
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

  // Resolve initial content once per cellId — prefer rich HTML, fall back to plain text.
  const initialContent = initialHtml && initialHtml.length > 0
    ? stripToAllowedHtml(initialHtml)
    : initialPlain

  const isReadOnly = !editable || Boolean(heldByLabel)

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastCommittedRef = useRef<string>(initialPlain)
  // Latest typed-but-not-yet-committed snapshot. Held so the unmount cleanup
  // can flush it (navigate-away / reload during the idle window must not drop
  // the edit into the void — the commit has to reach the outbox to survive).
  const pendingCommitRef = useRef<TranslatedEditorCommit | null>(null)
  const onCommitRef = useRef(onCommit)
  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])

  const commitEditorSnapshot = useRef<(reason?: string) => void>(() => undefined)

  const editor = useEditor({
    editable: !isReadOnly,
    content: initialContent,
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
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
    ],
    editorProps: {
      attributes: {
        // FRO-297: expose explicit textbox role + accessible label so screen
        // readers announce "GEN 1:1 — validated, editing" instead of the
        // generic ProseMirror contenteditable. aria-multiline signals that
        // Enter creates a new line, not submits (consistent with TipTap usage).
        role: "textbox",
        "aria-multiline": "true",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        class: cn(
          // The surrounding neu-inset well in EditorTable already reads as an
          // input, so the editor surface itself stays transparent — no flat
          // background tints competing with the soft recess.
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
        return stripToAllowedHtml(html)
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
      handleDOMEvents: {
        mouseover(view, event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>(".usfm-footnote-marker")
          if (!marker || !view.dom.contains(marker)) return false
          const index = Number(marker.dataset.footnoteIndex)
          onFootnoteHoverRef.current?.(Number.isFinite(index) ? index : null)
          return false
        },
        mouseout(view, event) {
          const target = event.target as HTMLElement | null
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
      // FRO-297: Escape commits pending work (via blur) and signals the parent
      // to return keyboard focus to the grid-row wrapper, exiting edit mode.
      handleKeyDown(view, event) {
        // FRO-297: Esc — commit-and-exit back to grid focus.
        if (event.key === "Escape") {
          event.preventDefault()
          // Blur the editor — this triggers the onBlur commit path so any
          // pending idle edits are flushed before focus moves to the row.
          view.dom.blur()
          onEscapeToGridRef.current?.()
          return true
        }
        const plain = !event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey
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
        if (plain && event.key === "ArrowLeft" && moveCaretAcrossFootnoteRaw(view, "left")) {
          event.preventDefault()
          return true
        }
        if (plain && event.key === "ArrowRight" && moveCaretAcrossFootnoteRaw(view, "right")) {
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
      // Reset idle timer on every keystroke; commit when the user pauses.
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
      const text = editor.getText()
      const html = editor.getHTML()
      pendingCommitRef.current = { value: text, valueHtml: html }
      idleTimerRef.current = setTimeout(() => {
        pendingCommitRef.current = null
        if (text === lastCommittedRef.current) return
        lastCommittedRef.current = text
        onCommitRef.current({ value: text, valueHtml: html })
      }, COMMIT_IDLE_MS)
    },
    onFocus() {
      onFocus?.()
    },
    onBlur({ editor }) {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      const text = editor.getText()
      const html = editor.getHTML()
      pendingCommitRef.current = null
      if (text !== lastCommittedRef.current) {
        lastCommittedRef.current = text
        onCommitRef.current({ value: text, valueHtml: html })
      }
      onBlur?.()
    },
  }, [cellId])

  commitEditorSnapshot.current = () => {
    if (!editor) return
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    const text = editor.getText()
    const html = editor.getHTML()
    pendingCommitRef.current = null
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
      const replacement = `${anchorText ?? ""}${marker}`
      const inserted = shouldReplaceAnchor
        ? editor.commands.insertContentAt({
          from: Math.max(1, Math.min(insertion.from, maxPosition)),
          to: Math.max(1, Math.min(insertion.to, maxPosition)),
        }, replacement, { updateSelection: false })
        : editor.commands.insertContentAt(
          Math.max(1, Math.min(insertion.position, maxPosition)),
          replacement,
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
  // Seed once per editor instance (one editor per cellId). (FRO-216)
  const lastHydratedPlainRef = useRef(initialPlain)
  useEffect(() => {
    if (!editor) return
    lastCommittedRef.current = editor.getText()
    lastHydratedPlainRef.current = initialPlain
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Re-hydrate only when the stored value genuinely changes (a remote
  // event.applied landed while we weren't editing) — keyed on the raw
  // `initialPlain` so an escaping-only difference never forces a reload. We
  // never overwrite if the editor is focused — that's what the banner is for.
  useEffect(() => {
    if (!editor) return
    if (editor.isFocused) return
    if (initialPlain === lastHydratedPlainRef.current) return
    lastHydratedPlainRef.current = initialPlain
    editor.commands.setContent(initialContent)
    lastCommittedRef.current = editor.getText()
  }, [editor, initialContent, initialPlain])

  useEffect(() => {
    editor?.setEditable(!isReadOnly)
  }, [editor, isReadOnly])

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
      {heldByLabel && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute right-1 top-1 z-10 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
        >
          {heldByLabel} is editing
        </div>
      )}
      {remoteChangedDuringEdit && onDiscardLocal && (
        <div className="mb-1 flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 shadow-neu-sm dark:bg-amber-950 dark:text-amber-300">
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
        <div className="absolute right-2 top-2 z-20 flex items-center gap-2 rounded-lg border border-destructive/20 bg-background px-2 py-1 text-[11px] shadow-neu-sm">
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
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor, from, to }) => editor.isFocused && from !== to}
        options={{ placement: "top" }}
      >
        <div className="flex gap-0.5 rounded-lg bg-card p-0.5 shadow-neu-sm">
          <AppTooltip content="Bold (Cmd+B)">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleBold().run()}
              aria-label="Bold"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
                editor.isActive("bold") && "bg-accent"
              )}
            >
              <Bold className="h-3 w-3" />
            </button>
          </AppTooltip>
          <AppTooltip content="Italic (Cmd+I)">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleItalic().run()}
              aria-label="Italic"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
                editor.isActive("italic") && "bg-accent"
              )}
            >
              <Italic className="h-3 w-3" />
            </button>
          </AppTooltip>
          <AppTooltip content="Underline (Cmd+U)">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              aria-label="Underline"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
                editor.isActive("underline") && "bg-accent"
              )}
            >
              <UnderlineIcon className="h-3 w-3" />
            </button>
          </AppTooltip>
          <AppTooltip content="Strikethrough">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleStrike().run()}
              aria-label="Strikethrough"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
                editor.isActive("strike") && "bg-accent"
              )}
            >
              <Strikethrough className="h-3 w-3" />
            </button>
          </AppTooltip>
          <AppTooltip content="Inline code">
            <button
              type="button"
              onClick={() => editor.chain().focus().toggleCode().run()}
              aria-label="Inline code"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
                editor.isActive("code") && "bg-accent"
              )}
            >
              <Code className="h-3 w-3" />
            </button>
          </AppTooltip>
        </div>
      </BubbleMenu>
      <div
        className={cn(compactHeight ? "" : "h-full")}
        onClick={(e) => {
          const target = e.target as HTMLElement
          // FRO-204: term chip click → open TermLookupPopover via caller
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

function moveCaretAcrossFootnoteRaw(
  view: EditorView,
  direction: "left" | "right",
): boolean {
  const { selection, doc } = view.state
  if (!selection.empty) return false
  const pos = selection.from
  const range = getFootnotePmRanges(doc).find((candidate) => (
    direction === "right"
      ? pos >= candidate.from && pos < candidate.to
      : pos > candidate.from && pos <= candidate.to
  ))
  if (!range) return false
  const nextPos = direction === "right" ? range.to : range.from
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, nextPos)).scrollIntoView())
  return true
}

function findFootnoteDeleteTarget(
  view: EditorView,
  key: "Backspace" | "Delete",
  numberOffset: number,
): (PendingFootnoteDelete & { from: number; to: number }) | null {
  const { selection, doc } = view.state
  const ranges = getFootnotePmTargets(doc, numberOffset)
  if (!selection.empty) {
    return ranges.find((range) => selection.from < range.to && selection.to > range.from) ?? null
  }
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
  const map = getDocumentTextMap(doc)
  if (!map.text) return null
  const footnotes = extractUsfmFootnotes(map.text)
  const hiddenRanges = footnotes.map((footnote) => ({
    from: footnote.index,
    to: footnote.index + footnote.raw.length,
  }))
  const isHidden = (offset: number) => hiddenRanges.some((range) => offset >= range.from && offset < range.to)
  const hiddenAtPosition = hiddenRanges.find((range) => {
    const plain = pmPositionToPlainPosition(doc, position)
    return plain >= range.from && plain <= range.to
  })

  let plainPosition = pmPositionToPlainPosition(doc, position)
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

function getFootnotePmRanges(doc: ProseMirrorNode): Array<{ from: number; to: number }> {
  return getFootnotePmTargets(doc, 0).map(({ from, to }) => ({ from, to }))
}

function getFootnotePmTargets(
  doc: ProseMirrorNode,
  numberOffset: number,
): Array<PendingFootnoteDelete & { from: number; to: number }> {
  const map = getDocumentTextMap(doc)
  return extractUsfmFootnotes(map.text)
    .map((footnote, i) => ({
      index: i,
      label: footnoteTargetLabel(footnote.caller, i, numberOffset),
      from: map.plainToPm[footnote.index],
      to: map.plainToPm[footnote.index + footnote.raw.length],
    }))
    .filter((range): range is PendingFootnoteDelete & { from: number; to: number } => (
      range.from !== undefined && range.to !== undefined && range.from < range.to
    ))
}

function footnoteTargetLabel(caller: string, index: number, numberOffset: number): string {
  const trimmed = caller.trim()
  if (trimmed && trimmed !== "+" && trimmed !== "-") return trimmed
  return String(numberOffset + index + 1)
}

function getDocumentTextMap(doc: ProseMirrorNode): { text: string; plainToPm: number[] } {
  const plainToPm: number[] = []
  let text = ""
  let plainCursor = 0
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const nodeText = node.text ?? ""
    for (let i = 0; i <= nodeText.length; i++) plainToPm[plainCursor + i] = pos + i
    text += nodeText
    plainCursor += nodeText.length
    return true
  })
  if (!(plainCursor in plainToPm)) plainToPm[plainCursor] = doc.content.size
  return { text, plainToPm }
}

function isWordChar(value: string): boolean {
  return /^[\p{L}\p{N}'’-]$/u.test(value)
}

function getWordAnchor(
  doc: ProseMirrorNode,
  position: number,
): FootnoteInsertionAnchor | null {
  const resolved = doc.resolve(position)
  const parentText = resolved.parent.textContent
  const parentOffset = resolved.parentOffset
  if (
    !parentText ||
    parentOffset >= parentText.length ||
    /\s/.test(parentText[parentOffset] ?? "") ||
    isFootnoteSyntaxAtOffset(parentText, parentOffset)
  ) {
    return null
  }

  let previousOffset = parentOffset
  while (previousOffset > 0 && !/\s/.test(parentText[previousOffset - 1] ?? "")) {
    previousOffset -= 1
  }
  let nextOffset = parentOffset
  while (nextOffset < parentText.length && !/\s/.test(parentText[nextOffset] ?? "")) {
    nextOffset += 1
  }
  const candidate = parentText.slice(previousOffset, nextOffset)
  if (candidate.includes("\\") || /^f\*?$/.test(candidate)) return null
  return {
    position: position + (nextOffset - parentOffset),
    from: position - (parentOffset - previousOffset),
    to: position + (nextOffset - parentOffset),
    plainPosition: pmPositionToPlainPosition(doc, position + (nextOffset - parentOffset)),
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
  let text = ""
  doc.descendants((node) => {
    if (node.isText) text += node.text ?? ""
  })
  return text
}

function pmPositionToPlainPosition(doc: ProseMirrorNode, position: number): number {
  let plainPosition = 0
  let found = false
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found
    const length = node.text?.length ?? 0
    if (position <= pos) {
      found = true
      return false
    }
    if (position <= pos + length) {
      plainPosition += Math.max(0, position - pos)
      found = true
      return false
    }
    plainPosition += length
    return true
  })
  return plainPosition
}

function normalizeAnchorPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 80) return normalized
  return `${normalized.slice(0, 77).trimEnd()}...`
}

// Strip pasted HTML to only the marks we support.
// Allowed tags: b, strong, i, em, u, s, strike, del, code, p, br
// Everything else is removed (content preserved).
function stripToAllowedHtml(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  walkAndStrip(doc.body)
  return doc.body.innerHTML
}

const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "CODE", "P", "BR"])

function walkAndStrip(el: Element): void {
  const children = Array.from(el.childNodes)
  for (const child of children) {
    if (child.nodeType === 1) {
      const elChild = child as Element
      walkAndStrip(elChild)
      if (!ALLOWED_TAGS.has(elChild.tagName)) {
        const parent = elChild.parentNode
        if (parent) {
          while (elChild.firstChild) parent.insertBefore(elChild.firstChild, elChild)
          parent.removeChild(elChild)
        }
      } else {
        const attrs = Array.from(elChild.attributes)
        for (const attr of attrs) elChild.removeAttribute(attr.name)
      }
    }
  }
}
