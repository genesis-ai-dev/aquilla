// The Bible document editor's schema and rules (AQU-2559).
//
// The document is one continuous text, but each verse saves to its own cell.
// Two things keep that true while the translator types freely:
//   - the SKELETON is fixed: verse chips, chapter labels and the source's own
//     headings can never be added, removed or reordered by an edit;
//   - words must belong to a verse, and a verse someone else holds is read-only.
// Every transaction that is not a sync from the store is checked against both.

import { Extension, Node } from "@tiptap/core"
import { history, redo, undo } from "@tiptap/pm/history"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { UnitLayout } from "./doc-model"
import { SYNC_META, cellAt, cellRanges, deleteWordsOnly, hasFixedNodes, readPm } from "./pm-helpers"

const PARA_CLASS = [
  "bd-para my-0 leading-[1.75]",
  "data-[marker=p]:indent-5 data-[marker=pi]:ps-6 data-[marker=pi1]:ps-6 data-[marker=mi]:ps-6",
  "data-[marker=q]:ps-8 data-[marker=q]:-indent-4 data-[marker=q1]:ps-8 data-[marker=q1]:-indent-4",
  "data-[marker=q2]:ps-12 data-[marker=q2]:-indent-4 data-[marker=q3]:ps-16 data-[marker=q3]:-indent-4",
  "data-[marker=q4]:ps-20 data-[marker=q4]:-indent-4 data-[marker=qm]:ps-10 data-[marker=qm1]:ps-10",
  "data-[marker=li]:ps-8 data-[marker=li1]:ps-8 data-[marker=li2]:ps-12",
  "data-[marker=qc]:text-center data-[marker=pc]:text-center data-[marker=qr]:text-end data-[marker=pr]:text-end",
  "data-[marker=b]:h-4",
].join(" ")

export const VERSE_CHIP_CLASS =
  "bd-verse me-1 select-none align-super text-[0.62em] font-semibold tabular-nums text-muted-foreground indent-0"
export const CHAPTER_CLASS =
  "bd-chapter float-start me-2 mt-1 select-none text-[2.6em] font-semibold leading-[0.9] text-foreground/80"
export const HEADING_CLASS = [
  "bd-heading mt-6 mb-2 clear-both text-[1.05em] font-semibold leading-snug text-foreground",
  // The book's title, and the running header and contents entries above it.
  "data-[marker^=mt]:mt-2 data-[marker^=mt]:mb-6 data-[marker^=mt]:text-center data-[marker^=mt]:text-[1.7em]",
  "data-[marker^=toc]:my-0 data-[marker^=toc]:text-[0.75em] data-[marker^=toc]:font-normal data-[marker^=toc]:text-muted-foreground",
  "data-[marker=h]:my-0 data-[marker=h]:text-[0.75em] data-[marker=h]:font-normal data-[marker=h]:text-muted-foreground",
].join(" ")

const Doc = Node.create({ name: "doc", topNode: true, content: "(chapterLabel | cellHeading | addedHeading | para)+" })
const Text = Node.create({ name: "text", group: "inline" })

const Para = Node.create({
  name: "para",
  content: "inline*",
  addAttributes: () => ({ marker: { default: "p", rendered: false } }),
  parseHTML: () => [{ tag: "p[data-marker]", getAttrs: (el) => ({ marker: (el as HTMLElement).dataset.marker ?? "p" }) }],
  renderHTML: ({ node }) => ["p", { "data-marker": node.attrs.marker as string, class: PARA_CLASS }, 0],
})

const ChapterLabel = Node.create({
  name: "chapterLabel",
  atom: true,
  selectable: false,
  addAttributes: () => ({ chapter: { default: 0, rendered: false } }),
  renderHTML: ({ node }) => [
    "div",
    { class: CHAPTER_CLASS, "data-chapter": String(node.attrs.chapter), contenteditable: "false" },
    String(node.attrs.chapter),
  ],
})

const CellHeading = Node.create({
  name: "cellHeading",
  content: "text*",
  isolating: true,
  defining: true,
  addAttributes: () => ({ cellId: { default: "", rendered: false }, marker: { default: "s1", rendered: false } }),
  renderHTML: ({ node }) => [
    "h3",
    { class: HEADING_CLASS, "data-cell-id": node.attrs.cellId as string, "data-marker": node.attrs.marker as string },
    0,
  ],
})

const AddedHeading = Node.create({
  name: "addedHeading",
  content: "text*",
  isolating: true,
  defining: true,
  addAttributes: () => ({ marker: { default: "s1", rendered: false } }),
  renderHTML: ({ node }) => ["h3", { class: HEADING_CLASS, "data-added-heading": "", "data-marker": node.attrs.marker as string }, 0],
})

const Verse = Node.create({
  name: "verse",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ cellId: { default: "", rendered: false }, label: { default: "", rendered: false } }),
  renderHTML: ({ node }) => [
    "span",
    { class: VERSE_CHIP_CLASS, "data-cell-id": node.attrs.cellId as string, contenteditable: "false" },
    (node.attrs.label as string) || "•",
  ],
})

const Note = Node.create({
  name: "note",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ raw: { default: "", rendered: false } }),
  renderHTML: ({ node }) => [
    "span",
    {
      class: "bd-note mx-0.5 cursor-default select-none rounded bg-muted px-1 align-super text-[0.62em] font-semibold text-muted-foreground",
      title: (node.attrs.raw as string).replace(/\\[a-z]+\d*\*?\s?/g, "").replace(/^[+-]\s*/, "").trim(),
      contenteditable: "false",
    },
    "†",
  ],
})

export interface BibleDocumentRules {
  layout: () => ReadonlyMap<string, UnitLayout>
  editable: () => boolean
  /** The person holding this cell, when it is not us. */
  lockedBy: (cellId: string) => string | null
  activeCellId: () => string | null
  /** The source words of a cell, drawn faintly where it has no translation. */
  ghost: (cellId: string) => string
  onRejected?: (reason: "skeleton" | "locked" | "read-only") => void
}

export const decorationsKey = new PluginKey<number>("bibleDocumentDecorations")

/** Ask the decorations to redraw (the active verse or the locks changed). */
export function refreshDecorations(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(decorationsKey, true).setMeta(SYNC_META, true).setMeta("addToHistory", false))
}

function changedCells(before: PMNode, after: PMNode, layout: ReadonlyMap<string, UnitLayout>): string[] {
  const a = readPm(before, layout).values
  const b = readPm(after, layout).values
  const out: string[] = []
  for (const [id, value] of b) if (a.get(id) !== value) out.push(id)
  return out
}

function guardPlugin(rules: BibleDocumentRules): Plugin {
  return new Plugin({
    key: new PluginKey("bibleDocumentGuard"),
    filterTransaction(tr: Transaction, state: EditorState) {
      if (!tr.docChanged || tr.getMeta(SYNC_META)) return true
      if (!rules.editable()) {
        rules.onRejected?.("read-only")
        return false
      }
      const layout = rules.layout()
      const before = readPm(state.doc, layout)
      const after = readPm(tr.doc, layout)
      const same = before.skeleton.length === after.skeleton.length && before.skeleton.every((id, i) => id === after.skeleton[i])
      if (!same || after.orphanText) {
        rules.onRejected?.("skeleton")
        return false
      }
      if (changedCells(state.doc, tr.doc, layout).some((id) => rules.lockedBy(id) !== null)) {
        rules.onRejected?.("locked")
        return false
      }
      return true
    },
  })
}

function decorationsPlugin(rules: BibleDocumentRules): Plugin<number> {
  let cache: { doc: PMNode; version: number; set: DecorationSet } | null = null
  return new Plugin<number>({
    key: decorationsKey,
    state: {
      init: () => 0,
      apply: (tr, version) => (tr.getMeta(decorationsKey) ? version + 1 : version),
    },
    props: {
      decorations(state) {
        const version = decorationsKey.getState(state) ?? 0
        if (cache && cache.doc === state.doc && cache.version === version) return cache.set
        const active = rules.activeCellId()
        const decorations: Decoration[] = []
        for (const range of cellRanges(state.doc)) {
          if (state.doc.textBetween(range.from, range.to, "", "x").trim() === "") {
            const ghost = rules.ghost(range.cellId)
            if (ghost !== "") {
              decorations.push(Decoration.widget(range.from, () => {
                const el = document.createElement("span")
                el.className = "bd-ghost select-none text-muted-foreground/45"
                el.contentEditable = "false"
                el.textContent = ghost
                return el
              }, { side: 1, key: `ghost:${range.cellId}:${ghost.length}`, ignoreSelection: true }))
            }
          }
          if (range.to <= range.from) continue
          const holder = rules.lockedBy(range.cellId)
          if (holder) decorations.push(Decoration.inline(range.from, range.to, { class: "bd-locked opacity-60", title: holder }))
          else if (range.cellId === active) decorations.push(Decoration.inline(range.from, range.to, { class: "bd-active rounded-sm bg-primary/[0.07]" }))
        }
        const set = DecorationSet.create(state.doc, decorations)
        cache = { doc: state.doc, version, set }
        return set
      },
    },
  })
}

/** Replace a selection that spans chips with typed or pasted words. */
function replaceWordsOnly(view: EditorView, from: number, to: number, text: string): boolean {
  if (from === to || !hasFixedNodes(view.state.doc, from, to)) return false
  const tr = view.state.tr
  const at = deleteWordsOnly(tr, from, to)
  if (text !== "") tr.insertText(text, at)
  tr.setSelection(TextSelection.create(tr.doc, at + text.length))
  view.dispatch(tr.scrollIntoView())
  return true
}

/** Enter: a new paragraph, in the same style. In a heading, move past it. */
function splitParagraph(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, from, to } = state.selection
  const parent = $from.parent
  if (parent.type.name !== "para") {
    const after = $from.after()
    if (dispatch && after < state.doc.content.size) dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(after), 1)).scrollIntoView())
    return true
  }
  if (from !== to && hasFixedNodes(state.doc, from, to)) return true
  const tr = state.tr
  if (from !== to) tr.delete(from, to)
  tr.split(tr.mapping.map(from), 1, [{ type: parent.type, attrs: { marker: parent.attrs.marker as string } }])
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

/** Backspace at the start of a block: join paragraphs, or step into the
 *  heading above. A chapter label or a source heading is a wall. */
function backspace(view: EditorView): boolean {
  const { state } = view
  const { $from, from, to, empty } = state.selection
  if (!empty) return replaceWordsOnly(view, from, to, "")
  if ($from.parentOffset > 0) return false
  const index = $from.index(0)
  const here = $from.parent
  if (here.type.name === "addedHeading" && here.content.size === 0) {
    const tr = state.tr.delete($from.before(), $from.after())
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min($from.before(), tr.doc.content.size)), 1)))
    return true
  }
  if (index === 0) return true
  const previous = state.doc.child(index - 1)
  if (here.type.name === "para" && previous.type.name === "para") {
    view.dispatch(state.tr.join($from.before()).scrollIntoView())
    return true
  }
  if (previous.type.name === "addedHeading") {
    const end = $from.before() - 1
    if (previous.content.size === 0) view.dispatch(state.tr.delete($from.before() - previous.nodeSize, $from.before()))
    else view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)))
  }
  return true
}

function forwardDelete(view: EditorView): boolean {
  const { state } = view
  const { $from, from, to, empty } = state.selection
  if (!empty) return replaceWordsOnly(view, from, to, "")
  if ($from.parentOffset < $from.parent.content.size) return false
  const index = $from.index(0)
  if (index >= state.doc.childCount - 1) return true
  const next = state.doc.child(index + 1)
  if ($from.parent.type.name === "para" && next.type.name === "para") view.dispatch(state.tr.join($from.after()))
  return true
}

/** Add a section heading before the verse the caret is in (or before the next
 *  verse, when the caret is at the end of this one). */
export function insertHeading(view: EditorView): boolean {
  const { state } = view
  const { $from, from } = state.selection
  if ($from.parent.type.name !== "para") return false
  const cells = cellRanges(state.doc).filter((c) => !c.heading)
  const current = cellAt(state.doc, from)
  if (!current || current.heading) return false
  const i = cells.indexOf(current)
  const atEnd = from >= current.to && cells[i + 1] !== undefined
  const target = atEnd ? cells[i + 1] : current
  const chipPos = target.from - 1
  const $chip = state.doc.resolve(chipPos)
  const tr = state.tr
  let blockStart = $chip.before()
  if ($chip.parentOffset > 0) {
    tr.split(chipPos, 1, [{ type: $chip.parent.type, attrs: { marker: $chip.parent.attrs.marker as string } }])
    blockStart = tr.mapping.map(chipPos) - 1
  }
  const heading = state.schema.nodes.addedHeading.create({ marker: "s1" })
  tr.insert(blockStart, heading)
  tr.setSelection(TextSelection.create(tr.doc, blockStart + 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/** Set the style of the paragraph the caret is in. */
export function setParagraphMarker(view: EditorView, marker: string): boolean {
  const { $from } = view.state.selection
  if ($from.parent.type.name !== "para") return false
  view.dispatch(view.state.tr.setNodeMarkup($from.before(), undefined, { marker }))
  view.focus()
  return true
}

export function bibleDocumentExtensions(rules: BibleDocumentRules) {
  const Rules = Extension.create({
    name: "bibleDocumentRules",
    // Above the default keymap, so these decide before a chip can be deleted.
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        history(),
        guardPlugin(rules),
        decorationsPlugin(rules),
        new Plugin({
          key: new PluginKey("bibleDocumentInput"),
          props: {
            handleTextInput: (view, from, to, text) => replaceWordsOnly(view, from, to, text),
            handlePaste: (view, event) => {
              const pasted = (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*\r?\n\s*/g, " ")
              if (pasted === "") return true
              const { from, to } = view.state.selection
              if (!replaceWordsOnly(view, from, to, pasted)) view.dispatch(view.state.tr.insertText(pasted, from, to).scrollIntoView())
              return true
            },
            handleDrop: () => true,
          },
        }),
      ]
    },
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => splitParagraph(editor.state, editor.view.dispatch),
        "Shift-Enter": ({ editor }) => splitParagraph(editor.state, editor.view.dispatch),
        Backspace: ({ editor }) => backspace(editor.view),
        Delete: ({ editor }) => forwardDelete(editor.view),
        "Mod-z": ({ editor }) => undo(editor.state, editor.view.dispatch),
        "Mod-y": ({ editor }) => redo(editor.state, editor.view.dispatch),
        "Shift-Mod-z": ({ editor }) => redo(editor.state, editor.view.dispatch),
        "Mod-Alt-h": ({ editor }) => insertHeading(editor.view),
      }
    },
  })
  return [Doc, Text, Para, ChapterLabel, CellHeading, AddedHeading, Verse, Note, Rules]
}
