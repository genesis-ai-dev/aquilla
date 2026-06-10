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
import StarterKit from "@tiptap/starter-kit"
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code } from "lucide-react"
import { cn } from "@/lib/utils"
import { useEffect, useRef } from "react"
import type { RuleInfraction } from "@/lib/parsers/types"
import { createViolationDecorationExtension, violationPluginKey } from "@/lib/richtext/violation-decoration-plugin"
import { createKaraokeExtension, karaokePluginKey, type KaraokePluginState } from "@/lib/richtext/karaoke-plugin"
import { createTerminologyChipExtension, terminologyChipPluginKey } from "@/lib/richtext/terminology-chip-plugin"
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
}

export function TranslatedEditor({
  cellId,
  initialHtml,
  initialPlain,
  onCommit,
  onFocus,
  onBlur,
  placeholder,
  className,
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
}: TranslatedEditorProps) {
  // Held in a ref so the editor's keydown handler — created once per cellId —
  // always sees the latest navigation callback without re-creating the editor.
  const onNavigateCellRef = useRef(onNavigateCell)
  useEffect(() => { onNavigateCellRef.current = onNavigateCell }, [onNavigateCell])
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
      createViolationDecorationExtension(() => latestViolationStateRef.current),
      createKaraokeExtension(() => latestKaraokeStateRef.current),
      ...(terminologyConcepts !== undefined
        ? [createTerminologyChipExtension(() => latestTerminologyConceptsRef.current)]
        : []),
    ],
    editorProps: {
      attributes: {
        class: cn(
          // The surrounding neu-inset well in EditorTable already reads as an
          // input, so the editor surface itself stays transparent — no flat
          // background tints competing with the soft recess.
          // No fixed text-* class: font size inherits from the target column
          // wrapper, which carries the per-file font-size pref inline.
          "prose prose-sm max-w-none h-full min-h-[40px] px-1 py-0.5 leading-relaxed focus:outline-none",
          "rounded-lg transition-colors",
          className
        ),
      },
      transformPastedHTML(html: string) {
        return stripToAllowedHtml(html)
      },
      // Cell navigation. Tab/Shift+Tab always step cells; Up/Down step cells
      // only at the first/last visual line so the caret can still move between
      // wrapped lines within a multi-line cell. Left/Right are untouched.
      handleKeyDown(view, event) {
        const navigate = onNavigateCellRef.current
        if (!navigate) return false
        if (event.key === "Tab") {
          event.preventDefault()
          navigate(event.shiftKey ? "prev" : "next")
          return true
        }
        const plain = !event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey
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
    <div className="relative h-full">
      {heldByLabel && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute right-1 top-1 z-10 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
          title={`${heldByLabel} is editing this cell`}
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
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor, from, to }) => editor.isFocused && from !== to}
        options={{ placement: "top" }}
      >
        <div className="flex gap-0.5 rounded-lg bg-card p-0.5 shadow-neu-sm">
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
              editor.isActive("bold") && "bg-accent"
            )}
            title="Bold (Cmd+B)"
          >
            <Bold className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
              editor.isActive("italic") && "bg-accent"
            )}
            title="Italic (Cmd+I)"
          >
            <Italic className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
              editor.isActive("underline") && "bg-accent"
            )}
            title="Underline (Cmd+U)"
          >
            <UnderlineIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleStrike().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
              editor.isActive("strike") && "bg-accent"
            )}
            title="Strikethrough"
          >
            <Strikethrough className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleCode().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-accent",
              editor.isActive("code") && "bg-accent"
            )}
            title="Inline code"
          >
            <Code className="h-3 w-3" />
          </button>
        </div>
      </BubbleMenu>
      <div
        className="h-full"
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
        <EditorContent editor={editor} className="h-full [&>.ProseMirror]:h-full" />
      </div>
    </div>
  )
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
