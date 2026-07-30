import { createHash } from "node:crypto"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import {
  IDML_SLOT_NODE_NAME,
  IDML_TOKEN_NODE_NAME,
  hasIdmlCellMetadata,
  idmlEditorExtensions,
  isEditableIdmlSelection,
  nearestEditableIdmlSlotPosition,
  prepareIdmlEditorContent,
  resolveIdmlEditorConfiguration,
  serializeIdmlEditorDocument,
  validateIdmlEditorCommit,
  type IdmlEditorConfiguration,
} from "@/lib/richtext/idml-editor"

const STYLE_BODY = "CharacterStyle/Body"
const STYLE_LOCKED = "CharacterStyle/Automatic"
const SOURCE_HTML =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="${STYLE_BODY}" data-idml-protected="slot">Alpha&nbsp;one</span>`
  + `<span data-idml-token="0" data-idml-token-kind="tab" data-idml-protected="token" contenteditable="false"></span>`
  + `<span data-idml-slot="1" data-idml-character-style="${STYLE_LOCKED}" data-idml-protected="slot" contenteditable="false">LOCK</span>`
  + `</p>`

const METADATA: IdmlFormatMetadataV2 = {
  version: 2,
  slotCount: 2,
  editableSlotIndexes: [0],
  protectedTokenCount: 1,
  anchorSequenceHash: createHash("sha256").update([
    `slot:0:editable:${STYLE_BODY}`,
    "token:0:tab",
    `slot:1:locked:${STYLE_LOCKED}`,
  ].join("\u0000")).digest("hex"),
}

const CONFIGURATION = {
  kind: "ready",
  context: { sourceHtml: SOURCE_HTML, metadata: METADATA },
} satisfies IdmlEditorConfiguration

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function createEditor(onRejected = vi.fn(), html = SOURCE_HTML): Editor {
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
        context: CONFIGURATION.context,
        onRejected,
      }),
    ],
  })
  editors.push(editor)
  return editor
}

function nodePosition(editor: Editor, name: string, ordinal = 0): number {
  let seen = 0
  let found = -1
  editor.state.doc.descendants((node, position) => {
    if (found >= 0) return false
    if (node.type.name !== name) return true
    if (seen === ordinal) {
      found = position
      return false
    }
    seen += 1
    return true
  })
  if (found < 0) throw new Error(`Missing ${name} #${ordinal}`)
  return found
}

describe("IDML editor sanitation and configuration", () => {
  it("preserves only the exact IDML attribute vocabulary and DOM-serialized NBSP", () => {
    const dirty = SOURCE_HTML
      .replace("<p ", `<p class="fake" onclick="alert(1)" `)
      .replace(
        `data-idml-protected="slot"`,
        `data-idml-protected="slot" style="color:red" data-not-idml="drop"`,
      )
    const template = document.createElement("template")
    template.innerHTML = dirty
    const domSerialized = template.innerHTML
    const safe = sanitizeIdmlEditorHtml(domSerialized)

    expect(safe).not.toMatch(/onclick|(?:^|\s)style=|class=|data-not-idml/)
    const result = validateIdmlTranslation(SOURCE_HTML, safe, METADATA)
    expect(result).toEqual({
      valid: true,
      diagnostics: [],
      slots: ["Alpha\u00a0one", "LOCK"],
    })
  })

  it("builds an empty target only for a genuinely untranslated cell", () => {
    const prepared = prepareIdmlEditorContent(CONFIGURATION, undefined, "")
    expect(prepared.error).toBeNull()
    expect(prepared.html).not.toContain("Alpha")
    expect(prepared.html).toContain("LOCK")
    expect(validateIdmlTranslation(SOURCE_HTML, prepared.html, METADATA).valid).toBe(true)

    const legacyPlainOnly = prepareIdmlEditorContent(CONFIGURATION, undefined, "translated")
    expect(legacyPlainOnly.error).toMatch(/plain text but no formatting anchors/i)
  })

  it("fails closed for unsupported metadata instead of selecting the generic editor", () => {
    expect(hasIdmlCellMetadata({ idml: null })).toBe(true)
    expect(hasIdmlCellMetadata({ format: "idml" })).toBe(false)
    const future = resolveIdmlEditorConfiguration(
      { idml: { ...METADATA, version: 3 } },
      SOURCE_HTML,
    )
    expect(future).toMatchObject({ kind: "error" })
    expect(future && "error" in future ? future.error : "").toMatch(/newer metadata version/i)
  })

  it("blocks invalid HTML at the final commit boundary", () => {
    expect(validateIdmlEditorCommit(CONFIGURATION, SOURCE_HTML)).toBeNull()
    expect(validateIdmlEditorCommit(
      CONFIGURATION,
      SOURCE_HTML.replace("data-idml-slot=\"0\"", "data-idml-slot=\"9\""),
    )).toMatch(/IDML slot 9/i)
    expect(validateIdmlEditorCommit(
      { kind: "error", error: "repair required" },
      "<p>plain text</p>",
    )).toBe("repair required")
  })
})

describe("IDML ProseMirror transaction guard", () => {
  it("accepts text, bare line breaks, undo, and redo without changing anchors", () => {
    const rejected = vi.fn()
    const editor = createEditor(rejected)
    if (serializeIdmlEditorDocument(editor.state.doc) === null) {
      throw new Error(JSON.stringify(editor.state.doc.toJSON()))
    }
    const slotPosition = nodePosition(editor, IDML_SLOT_NODE_NAME)
    const slot = editor.state.doc.nodeAt(slotPosition)
    expect(slot).toBeTruthy()

    const textTransaction = editor.state.tr.insertText(
      "Bonjour\u00a0monde",
      slotPosition + 1,
      slotPosition + 1 + (slot?.content.size ?? 0),
    )
    const textCandidate = serializeIdmlEditorDocument(textTransaction.doc)
    if (textCandidate === null) throw new Error(JSON.stringify(textTransaction.doc.toJSON()))
    const textValidation = validateIdmlTranslation(SOURCE_HTML, textCandidate, METADATA)
    if (!textValidation.valid) {
      throw new Error(JSON.stringify({ textCandidate, diagnostics: textValidation.diagnostics }))
    }
    editor.view.dispatch(textTransaction)
    expect(serializeIdmlEditorDocument(editor.state.doc)).not.toBeNull()
    const updatedSlot = editor.state.doc.nodeAt(slotPosition)
    editor.view.dispatch(
      editor.state.tr.insert(
        slotPosition + 1 + (updatedSlot?.content.size ?? 0),
        editor.state.schema.nodes.hardBreak.create(),
      ),
    )

    const edited = serializeIdmlEditorDocument(editor.state.doc)
    if (edited === null) {
      throw new Error(JSON.stringify({
        doc: editor.state.doc.toJSON(),
        rejected: rejected.mock.calls,
      }))
    }
    expect(edited).toContain("Bonjour\u00a0monde<br>")
    expect(edited && validateIdmlTranslation(SOURCE_HTML, edited, METADATA).valid).toBe(true)
    expect(rejected).not.toHaveBeenCalled()

    expect(editor.commands.undo()).toBe(true)
    expect(editor.commands.redo()).toBe(true)
    expect(serializeIdmlEditorDocument(editor.state.doc)).toBe(edited)
    expect(rejected).not.toHaveBeenCalled()
  })

  it.each([
    ["renumbering a slot", (editor: Editor) => {
      const position = nodePosition(editor, IDML_SLOT_NODE_NAME)
      const node = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
        ...node.attrs,
        slot: 9,
      }))
    }],
    ["changing a character style", (editor: Editor) => {
      const position = nodePosition(editor, IDML_SLOT_NODE_NAME)
      const node = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
        ...node.attrs,
        characterStyle: "CharacterStyle/Other",
      }))
    }],
    ["deleting a token", (editor: Editor) => {
      const position = nodePosition(editor, IDML_TOKEN_NODE_NAME)
      const node = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.delete(position, position + node.nodeSize))
    }],
    ["duplicating a token", (editor: Editor) => {
      const position = nodePosition(editor, IDML_TOKEN_NODE_NAME)
      const node = editor.state.doc.nodeAt(position)!
      editor.view.dispatch(editor.state.tr.insert(position, node.copy()))
    }],
    ["reordering a token", (editor: Editor) => {
      const tokenPosition = nodePosition(editor, IDML_TOKEN_NODE_NAME)
      const token = editor.state.doc.nodeAt(tokenPosition)!
      const secondSlotPosition = nodePosition(editor, IDML_SLOT_NODE_NAME, 1)
      const secondSlot = editor.state.doc.nodeAt(secondSlotPosition)!
      const transaction = editor.state.tr.delete(
        tokenPosition,
        tokenPosition + token.nodeSize,
      )
      transaction.insert(
        transaction.mapping.map(secondSlotPosition + secondSlot.nodeSize),
        token,
      )
      editor.view.dispatch(transaction)
    }],
  ])("rejects %s", (_label, mutate) => {
    const rejected = vi.fn()
    const editor = createEditor(rejected)
    const before = editor.state.doc.toJSON()

    mutate(editor)

    expect(editor.state.doc.toJSON()).toEqual(before)
    expect(rejected).toHaveBeenCalledTimes(1)
  })
})

// AQU-740: the paragraph holds valid text positions *between* its inline
// slot/token anchors. A caret left in one of those (Selection.atStart/atEnd, the
// grid's "collapse a DOM range to the end of the editor" focus, a click on a
// protected token) typed into no slot at all.
describe("IDML caret placement", () => {
  const emptyTargetHtml = prepareIdmlEditorContent(CONFIGURATION, undefined, "").html

  it("maps a caret parked outside every slot onto the closest editable position", () => {
    const editor = createEditor(vi.fn())
    const slotPosition = nodePosition(editor, IDML_SLOT_NODE_NAME)
    const slot = editor.state.doc.nodeAt(slotPosition)!
    const slotStart = slotPosition + 1
    const slotEnd = slotStart + slot.content.size

    // Positions inside the only editable slot are already usable.
    expect(nearestEditableIdmlSlotPosition(editor.state.doc, slotStart)).toBeNull()
    expect(nearestEditableIdmlSlotPosition(editor.state.doc, slotEnd)).toBeNull()
    // Paragraph start/end and the gap around the locked slot are not.
    expect(nearestEditableIdmlSlotPosition(editor.state.doc, slotPosition)).toBe(slotStart)
    expect(nearestEditableIdmlSlotPosition(
      editor.state.doc,
      editor.state.doc.content.size,
    )).toBe(slotEnd)
  })

  it("starts an untranslated unit at its first editable slot", async () => {
    const editor = createEditor(vi.fn(), emptyTargetHtml)
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1

    // TipTap emits `create` on a macrotask, so the initial caret lands a tick
    // after construction — still well before the editor can be typed into.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(isEditableIdmlSelection(editor.state.selection)).toBe(true)
    expect(editor.state.selection.from).toBe(slotStart)
    // Even a caret asked for at the far end of the paragraph — which is where
    // the grid's focus-and-collapse lands — comes back to the first slot.
    expect(nearestEditableIdmlSlotPosition(
      editor.state.doc,
      editor.state.doc.content.size,
    )).toBe(slotStart)
  })

  it("pulls a stray caret back into a slot but leaves range selections alone", () => {
    const editor = createEditor(vi.fn(), emptyTargetHtml)
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1

    editor.commands.focus("end")
    expect(isEditableIdmlSelection(editor.state.selection)).toBe(true)
    expect(editor.state.selection.from).toBe(slotStart)

    // Selecting across protected anchors stays intact so text can be copied.
    editor.commands.selectAll()
    expect(editor.state.selection.empty).toBe(false)
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size)
  })
})
