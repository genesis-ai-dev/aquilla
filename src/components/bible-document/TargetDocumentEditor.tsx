// The translation side of the Bible document (AQU-2559): one continuous editor
// over a whole book. Each verse still saves to its own cell, through the same
// commit path the table uses.
//
// A SaveLedger (src/lib/bible-document/save-ledger.ts) keeps the document and
// the store in step. A store change repaints only the cells the ledger says
// are news, so a save echoing back, or a colleague's edit in another verse,
// never moves the caret.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { Fragment } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { buildDoc, layoutOf, readDoc, type UnitLayout } from "@/lib/bible-document/doc-model"
import {
  bibleDocumentExtensions,
  insertHeading,
  refreshDecorations,
  setParagraphMarker,
} from "@/lib/bible-document/editor-extensions"
import { SYNC_META, cellAt, cellRanges, patchChangedCells, readPm } from "@/lib/bible-document/pm-helpers"
import { SaveLedger } from "@/lib/bible-document/save-ledger"
import type { DocUnit } from "@/lib/bible-document/units"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import { cn } from "@/lib/utils"

/** Idle time before typed words are saved; the table editor's own figure. */
const SAVE_IDLE_MS = 1_200

export interface TargetDocumentHandle {
  focusCell: (cellId: string) => boolean
  insertHeading: () => void
  setParagraphMarker: (marker: string) => void
  /** Save everything typed so far. */
  flush: () => Promise<void>
}

export interface TargetDocumentEditorProps {
  units: readonly DocUnit[]
  editable: boolean
  /** The person holding this cell, when it is not us. Read at call time. */
  lockedBy: (cellId: string) => string | null
  /** Changes whenever the set of locks does. */
  lockVersion: unknown
  dir?: "ltr" | "rtl"
  fontSize?: number
  ariaLabel: string
  onCommit: (cellId: string, value: string) => Promise<void>
  onActiveCellChange: (cellId: string | null) => void
  onParagraphMarkerChange: (marker: string | null) => void
  onUnsavedChange: (unsaved: ReadonlyMap<string, string>, failed: number) => void
  onRejected?: (reason: "skeleton" | "locked" | "read-only") => void
}

function skeletonKey(units: readonly DocUnit[]): string {
  return units.map((u) => `${u.cellId}:${u.chapter ?? ""}:${u.kind}`).join("|")
}

export const TargetDocumentEditor = forwardRef<TargetDocumentHandle, TargetDocumentEditorProps>(function TargetDocumentEditor(
  { units, editable, lockedBy, lockVersion, dir, fontSize, ariaLabel, onCommit, onActiveCellChange, onParagraphMarkerChange, onUnsavedChange, onRejected },
  ref,
) {
  const layoutRef = useRef<ReadonlyMap<string, UnitLayout>>(new Map())
  const ledgerRef = useRef(new SaveLedger())
  const skeletonRef = useRef("")
  const ghostRef = useRef<ReadonlyMap<string, string>>(new Map())
  const activeRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushingRef = useRef(false)
  const againRef = useRef(false)

  // Callbacks and flags the editor's plugins read at call time.
  const live = useRef({ editable, lockedBy, onCommit, onActiveCellChange, onParagraphMarkerChange, onUnsavedChange, onRejected })
  live.current = { editable, lockedBy, onCommit, onActiveCellChange, onParagraphMarkerChange, onUnsavedChange, onRejected }

  const report = useCallback(() => {
    const { unsaved, failed } = ledgerRef.current.snapshot()
    live.current.onUnsavedChange(unsaved, failed)
  }, [])

  const flush = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (flushingRef.current) {
      againRef.current = true
      return
    }
    flushingRef.current = true
    try {
      for (const [cellId, value] of ledgerRef.current.pending()) {
        if (live.current.lockedBy(cellId)) continue
        const settle = ledgerRef.current.begin(cellId, value)
        try {
          await live.current.onCommit(cellId, value)
          settle(true)
        } catch (error) {
          console.warn("[bible-document] save failed:", error)
          settle(false)
        }
      }
    } finally {
      flushingRef.current = false
      report()
      if (againRef.current) {
        againRef.current = false
        void flush()
      }
    }
  }, [report])

  const extensions = useMemo(
    () =>
      bibleDocumentExtensions({
        layout: () => layoutRef.current,
        editable: () => live.current.editable,
        lockedBy: (cellId) => live.current.lockedBy(cellId),
        activeCellId: () => activeRef.current,
        ghost: (cellId) => ghostRef.current.get(cellId) ?? "",
        onRejected: (reason) => live.current.onRejected?.(reason),
      }),
    [],
  )

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [{ type: "para", attrs: { marker: "p" } }] },
    editorProps: {
      attributes: {
        class: "bd-target min-h-full outline-none",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor: instance, transaction }) => {
      if (transaction.getMeta(SYNC_META)) return
      const before = readPm(transaction.before, layoutRef.current).values
      const after = readPm(instance.state.doc, layoutRef.current).values
      for (const [cellId, value] of after) {
        if (before.get(cellId) !== value) ledgerRef.current.edited(cellId, value)
      }
      report()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void flush(), SAVE_IDLE_MS)
    },
    onSelectionUpdate: ({ editor: instance }) => {
      const { state, view } = instance
      const cell = view.hasFocus() ? cellAt(state.doc, state.selection.head) : null
      const parent = state.selection.$head.parent
      live.current.onParagraphMarkerChange(parent.type.name === "para" ? (parent.attrs.marker as string) : null)
      const next = cell?.cellId ?? null
      if (next === activeRef.current) return
      activeRef.current = next
      live.current.onActiveCellChange(next)
      refreshDecorations(view)
      // Leaving a verse saves it, as leaving a row does in the table.
      void flush()
    },
    onFocus: ({ editor: instance }) => {
      const cell = cellAt(instance.state.doc, instance.state.selection.head)
      if (!cell || cell.cellId === activeRef.current) return
      activeRef.current = cell.cellId
      live.current.onActiveCellChange(cell.cellId)
      refreshDecorations(instance.view)
    },
    onBlur: ({ editor: instance }) => {
      if (activeRef.current !== null) {
        activeRef.current = null
        live.current.onActiveCellChange(null)
        refreshDecorations(instance.view)
      }
      void flush()
    },
    // Created once. Every handler above reads `live`, so nothing here goes
    // stale, and the editor is never handed new options while someone types:
    // TipTap applies changed options by redrawing, which can drop characters
    // the browser has inserted but the editor has not read yet.
  }, [])

  // Store -> document.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    layoutRef.current = layoutOf(units)
    ghostRef.current = new Map(units.map((u) => [u.cellId, usfmDisplayText(u.source).replace(/\s+/g, " ")]))
    const ledger = ledgerRef.current
    const shown = () => units.map((u) => ({ ...u, target: ledger.shown(u.cellId, u.target) }))
    const replaceAll = (content: ReturnType<typeof buildDoc>["content"]) => {
      const { state, view } = editor
      view.dispatch(
        state.tr
          .replaceWith(0, state.doc.content.size, Fragment.fromJSON(state.schema, content))
          .setMeta(SYNC_META, true)
          .setMeta("addToHistory", false),
      )
    }
    const key = skeletonKey(units)

    if (key !== skeletonRef.current) {
      // Cells were added, removed or are still arriving: lay the book out again.
      skeletonRef.current = key
      ledger.reset(units.map((u) => [u.cellId, u.target] as const))
      replaceAll(buildDoc(shown()).content)
      return
    }

    const changed = new Set<string>()
    for (const u of units) if (ledger.storeHolds(u.cellId, u.target)) changed.add(u.cellId)
    if (changed.size === 0) return
    const desired = buildDoc(shown())
    const tr = patchChangedCells(editor.state, editor.state.schema, desired, changed)
    if (tr) editor.view.dispatch(tr)
    else if (readDoc(desired, layoutRef.current).skeleton.join("|") !== readPm(editor.state.doc, layoutRef.current).skeleton.join("|")) {
      replaceAll(desired.content)
    }
  }, [editor, units])

  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshDecorations(editor.view)
  }, [editor, lockVersion])

  // Save what is left when the view closes.
  useEffect(() => () => void flush(), [flush])

  useImperativeHandle(ref, () => ({
    focusCell: (cellId) => {
      if (!editor || editor.isDestroyed) return false
      const range = cellRanges(editor.state.doc).find((c) => c.cellId === cellId)
      if (!range) return false
      const { state, view } = editor
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from)).scrollIntoView().setMeta("addToHistory", false))
      view.focus()
      return true
    },
    insertHeading: () => {
      if (editor && !editor.isDestroyed) insertHeading(editor.view)
    },
    setParagraphMarker: (marker) => {
      if (editor && !editor.isDestroyed) setParagraphMarker(editor.view, marker)
    },
    flush,
  }), [editor, flush])

  return (
    <EditorContent
      editor={editor}
      dir={dir}
      className={cn("h-full font-serif text-foreground", !editable && "cursor-default")}
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    />
  )
})
