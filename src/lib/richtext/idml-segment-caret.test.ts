import { createHash } from "node:crypto"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import {
  IDML_SLOT_NODE_NAME,
  idmlEditorExtensions,
  type IdmlEditorConfiguration,
} from "@/lib/richtext/idml-editor"
import { idmlSegmentCaretStep } from "./idml-segment-caret"

const BODY = "CharacterStyle/Body"
const BOLD = "CharacterStyle/Bold"
const ITALIC = "CharacterStyle/Italic"
const LOCKED = "CharacterStyle/Automatic"

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex")
}

const THREE_HTML =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="${BODY}" data-idml-protected="slot">Hello</span>`
  + `<span data-idml-slot="1" data-idml-character-style="${BOLD}" data-idml-protected="slot"></span>`
  + `<span data-idml-slot="2" data-idml-character-style="${ITALIC}" data-idml-protected="slot">world</span>`
  + `</p>`

const THREE_METADATA: IdmlFormatMetadataV2 = {
  version: 2,
  slotCount: 3,
  editableSlotIndexes: [0, 1, 2],
  protectedTokenCount: 0,
  anchorSequenceHash: hash([
    `slot:0:editable:${BODY}`,
    `slot:1:editable:${BOLD}`,
    `slot:2:editable:${ITALIC}`,
  ]),
}

const LOCKED_HTML =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="${BODY}" data-idml-protected="slot">Hello</span>`
  + `<span data-idml-slot="1" data-idml-character-style="${LOCKED}" data-idml-protected="slot" contenteditable="false">LOCK</span>`
  + `<span data-idml-slot="2" data-idml-character-style="${ITALIC}" data-idml-protected="slot">world</span>`
  + `</p>`

const LOCKED_METADATA: IdmlFormatMetadataV2 = {
  version: 2,
  slotCount: 3,
  editableSlotIndexes: [0, 2],
  protectedTokenCount: 0,
  anchorSequenceHash: hash([
    `slot:0:editable:${BODY}`,
    `slot:1:locked:${LOCKED}`,
    `slot:2:editable:${ITALIC}`,
  ]),
}

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function createEditor(html: string, metadata: IdmlFormatMetadataV2): Editor {
  const configuration = {
    kind: "ready",
    context: { sourceHtml: html, metadata },
  } satisfies IdmlEditorConfiguration
  const editor = new Editor({
    content: html,
    extensions: [
      StarterKit.configure({
        document: false,
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      ...idmlEditorExtensions({
        context: configuration.context,
        onRejected: vi.fn(),
      }),
    ],
  })
  editors.push(editor)
  return editor
}

function slotSpan(editor: Editor, ordinal: number): { start: number; end: number } {
  let seen = 0
  let found: { start: number; end: number } | null = null
  editor.state.doc.descendants((node, position) => {
    if (found) return false
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    if (seen === ordinal) {
      const start = position + 1
      found = { start, end: start + node.content.size }
      return false
    }
    seen += 1
    return true
  })
  if (!found) throw new Error(`Missing slot ${ordinal}`)
  return found
}

function caretAt(editor: Editor, position: number): { empty: boolean; from: number } {
  const selection = TextSelection.create(editor.state.doc, position)
  return { empty: selection.empty, from: selection.from }
}

describe("idmlSegmentCaretStep", () => {
  it("moves from the end of a run into the next run, including an empty one", () => {
    const editor = createEditor(THREE_HTML, THREE_METADATA)
    const first = slotSpan(editor, 0)
    const empty = slotSpan(editor, 1)
    const last = slotSpan(editor, 2)

    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, first.end), "forward")).toBe(empty.start)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, empty.start), "forward")).toBe(last.start)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, last.start), "backward")).toBe(empty.end)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, empty.end), "backward")).toBe(first.end)
  })

  it("leaves the caret inside a run so character movement stays natural", () => {
    const editor = createEditor(THREE_HTML, THREE_METADATA)
    const first = slotSpan(editor, 0)
    const middle = first.start + 2
    expect(middle).toBeLessThan(first.end)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, middle), "forward")).toBeNull()
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, middle), "backward")).toBeNull()
  })

  it("walks a character through adjacent plain runs instead of stopping between them", () => {
    const html =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="${BODY}" data-idml-protected="slot">Hello </span>`
      + `<span data-idml-slot="1" data-idml-character-style="${BODY}" data-idml-protected="slot">world</span>`
      + `</p>`
    const metadata: IdmlFormatMetadataV2 = {
      version: 2,
      slotCount: 2,
      editableSlotIndexes: [0, 1],
      protectedTokenCount: 0,
      anchorSequenceHash: hash([
        `slot:0:editable:${BODY}`,
        `slot:1:editable:${BODY}`,
      ]),
    }
    const editor = createEditor(html, metadata)
    const first = slotSpan(editor, 0)
    const second = slotSpan(editor, 1)

    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, first.end), "forward")).toBe(second.start + 1)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, second.start), "backward")).toBe(first.end - 1)
  })

  it("skips an empty plain run and stops in the bold block", () => {
    const html =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="${BODY}" data-idml-protected="slot">Hello</span>`
      + `<span data-idml-slot="1" data-idml-character-style="${BODY}" data-idml-protected="slot"></span>`
      + `<span data-idml-slot="2" data-idml-character-style="${BOLD}" data-idml-protected="slot"></span>`
      + `</p>`
    const metadata: IdmlFormatMetadataV2 = {
      version: 2,
      slotCount: 3,
      editableSlotIndexes: [0, 1, 2],
      protectedTokenCount: 0,
      anchorSequenceHash: hash([
        `slot:0:editable:${BODY}`,
        `slot:1:editable:${BODY}`,
        `slot:2:editable:${BOLD}`,
      ]),
    }
    const editor = createEditor(html, metadata)
    const first = slotSpan(editor, 0)
    const bold = slotSpan(editor, 2)

    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, first.end), "forward")).toBe(bold.start)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, bold.start), "backward")).toBe(first.end)
  })

  it("skips a locked run and lands in the next editable one", () => {
    const editor = createEditor(LOCKED_HTML, LOCKED_METADATA)
    const first = slotSpan(editor, 0)
    const last = slotSpan(editor, 2)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, first.end), "forward")).toBe(last.start)
    expect(idmlSegmentCaretStep(editor.state.doc, caretAt(editor, last.start), "backward")).toBe(first.end)
  })
})
