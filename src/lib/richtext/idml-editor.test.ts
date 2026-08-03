import { createHash } from "node:crypto"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import {
  IDML_SLOT_NODE_NAME,
  IDML_TOKEN_NODE_NAME,
  editableIdmlRangesIn,
  hasIdmlCellMetadata,
  idmlDeletionRange,
  idmlEditablePlainOffsetPosition,
  idmlEditableSlotOffsetPosition,
  idmlEditorExtensions,
  prepareIdmlEditorContent,
  resolveIdmlEditorConfiguration,
  sanitizeIdmlSlotInsertion,
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

const SINGLE_SLOT_SOURCE =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="${STYLE_BODY}" data-idml-protected="slot">Alpha</span>`
  + `</p>`

const SINGLE_SLOT_CONFIGURATION = {
  kind: "ready",
  context: {
    sourceHtml: SINGLE_SLOT_SOURCE,
    metadata: {
      version: 2,
      slotCount: 1,
      editableSlotIndexes: [0],
      protectedTokenCount: 0,
      anchorSequenceHash: createHash("sha256")
        .update(`slot:0:editable:${STYLE_BODY}`)
        .digest("hex"),
    },
  },
} satisfies IdmlEditorConfiguration

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function createEditor(
  onRejected = vi.fn(),
  html = SOURCE_HTML,
  context = CONFIGURATION.context,
): Editor {
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
        context,
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
  it("maps a read-surface slot offset to the matching ProseMirror position", () => {
    const editor = createEditor()
    const slotPosition = nodePosition(editor, IDML_SLOT_NODE_NAME)
    expect(idmlEditableSlotOffsetPosition(editor.state.doc, 0, 5)).toBe(slotPosition + 6)
    expect(idmlEditableSlotOffsetPosition(editor.state.doc, 0, 5_000)).toBe(
      slotPosition + 1 + editor.state.doc.nodeAt(slotPosition)!.content.size,
    )
    expect(idmlEditableSlotOffsetPosition(editor.state.doc, 1, 0)).toBeNull()
    expect(idmlEditablePlainOffsetPosition(editor.state.doc, 5)).toBe(slotPosition + 6)
  })

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

// AQU-740: deletion cannot be left to the browser — removing a slot's last
// character makes it drop the emptied span, which the guard refuses as anchor
// removal, so deletion ranges are computed against the document instead.
describe("IDML deletion ranges", () => {
  it("confines a range to the editable slots it covers", () => {
    const editor = createEditor(vi.fn())
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1
    const slotEnd = slotStart + editor.state.doc.nodeAt(slotStart - 1)!.content.size

    // A whole-document range keeps only the editable slot's text: the tab token
    // and the locked "LOCK" slot are structure, not the translator's content.
    expect(editableIdmlRangesIn(editor.state.doc, 0, editor.state.doc.content.size))
      .toEqual([{ from: slotStart, to: slotEnd }])
    // A range covering only protected anchors has nothing to write over.
    expect(editableIdmlRangesIn(editor.state.doc, slotEnd + 1, editor.state.doc.content.size))
      .toEqual([])
  })

  it("deletes within a slot and never past its protected edges", () => {
    const editor = createEditor(vi.fn())
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1
    const slotEnd = slotStart + editor.state.doc.nodeAt(slotStart - 1)!.content.size
    const rangeAt = (
      position: number,
      direction: "backward" | "forward",
      granularity: "character" | "word" | "line" = "character",
    ) => {
      editor.commands.setTextSelection(position)
      return idmlDeletionRange(editor.state.doc, editor.state.selection, direction, granularity)
    }

    expect(rangeAt(slotEnd, "backward")).toEqual({ from: slotEnd - 1, to: slotEnd })
    expect(rangeAt(slotStart, "forward")).toEqual({ from: slotStart, to: slotStart + 1 })
    // Backspace at the slot start and Delete at its end would take protected
    // structure with them, so they delete nothing at all.
    expect(rangeAt(slotStart, "backward")).toBeNull()
    expect(rangeAt(slotEnd, "forward")).toBeNull()
    // "Alpha one" — one word back from the end.
    expect(rangeAt(slotEnd, "backward", "word")).toEqual({ from: slotEnd - 3, to: slotEnd })
    expect(rangeAt(slotEnd, "backward", "line")).toEqual({ from: slotStart, to: slotEnd })
  })

  it("steps over a whole grapheme rather than half a surrogate pair", () => {
    const editor = createEditor(vi.fn())
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1
    const slot = editor.state.doc.nodeAt(slotStart - 1)!
    editor.commands.insertContentAt(
      { from: slotStart, to: slotStart + slot.content.size },
      "👍🏽",
    )
    const emojiEnd = slotStart + (editor.state.doc.nodeAt(slotStart - 1)?.content.size ?? 0)
    editor.commands.setTextSelection(emojiEnd)

    expect(idmlDeletionRange(editor.state.doc, editor.state.selection, "backward", "character"))
      .toEqual({ from: slotStart, to: emojiEnd })
  })
})

// AQU-740: ProseMirror only appends its trailing-break compensation to
// textblocks; inline IDML slots miss it, so the caret after a trailing <br>
// had no layout box and the browser painted the cursor at the first line.
describe("IDML trailing break caret box", () => {
  it("renders a caret box for a trailing hard break and drops it when text follows", () => {
    const editor = createEditor(vi.fn(), SINGLE_SLOT_SOURCE, SINGLE_SLOT_CONFIGURATION.context)
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1
    const slotEnd = slotStart + editor.state.doc.nodeAt(slotStart - 1)!.content.size
    expect(editor.view.dom.querySelector(".idml-trailing-break")).toBeNull()

    editor.view.dispatch(editor.state.tr.insert(slotEnd, editor.state.schema.nodes.hardBreak.create()))
    expect(editor.view.dom.querySelector(".idml-trailing-break")).toBeTruthy()
    // The widget is view-only: exactly the one real break serializes.
    const serialized = serializeIdmlEditorDocument(editor.state.doc)
    expect(serialized?.match(/<br>/g)).toHaveLength(1)
    expect(validateIdmlTranslation(
      SINGLE_SLOT_SOURCE,
      serialized!,
      SINGLE_SLOT_CONFIGURATION.context.metadata,
    ).valid).toBe(true)

    editor.view.dispatch(editor.state.tr.insertText("x", slotEnd + 1))
    expect(editor.view.dom.querySelector(".idml-trailing-break")).toBeNull()
  })

  it("adds no synthetic break while rendered content follows the hard break", () => {
    // Default fixture: the locked "LOCK" slot renders after slot 0, so the
    // break already has a following line box to give the caret.
    const editor = createEditor(vi.fn())
    const slotStart = nodePosition(editor, IDML_SLOT_NODE_NAME) + 1
    const slotEnd = slotStart + editor.state.doc.nodeAt(slotStart - 1)!.content.size

    editor.view.dispatch(editor.state.tr.insert(slotEnd, editor.state.schema.nodes.hardBreak.create()))
    expect(editor.view.dom.querySelector("span[data-idml-slot=\"0\"] br")).toBeTruthy()
    expect(editor.view.dom.querySelector(".idml-trailing-break")).toBeNull()
  })
})

describe("sanitizeIdmlSlotInsertion (AQU-758)", () => {
  it("collapses doubled spaces and drops leading/trailing spaces on paste into an empty slot", () => {
    expect(sanitizeIdmlSlotInsertion("  hello   world  ", "", "", "paste")).toBe("hello world")
  })

  it("keeps a single word separator when pasting against existing slot text", () => {
    // Caret sits after "Source" (before = "e"), so a leading space is a real
    // word gap and survives; a doubled interior space is still collapsed.
    expect(sanitizeIdmlSlotInsertion(" Pasted  text", "e", "", "paste")).toBe(" Pasted text")
  })

  it("drops a leading space that would double against a preceding space", () => {
    expect(sanitizeIdmlSlotInsertion(" more", " ", "", "paste")).toBe("more")
  })

  it("preserves line breaks but strips spaces that would abut them", () => {
    expect(sanitizeIdmlSlotInsertion("a \n b", "", "", "paste")).toBe("a\nb")
  })

  it("leaves non-breaking spaces and other Unicode whitespace untouched", () => {
    expect(sanitizeIdmlSlotInsertion("keep nbsp", "x", "y", "paste")).toBe("keep nbsp")
  })

  it("blocks a leading space typed into an empty slot", () => {
    expect(sanitizeIdmlSlotInsertion(" ", "", "", "type")).toBe("")
  })

  it("blocks a second consecutive space typed after an existing space", () => {
    expect(sanitizeIdmlSlotInsertion(" ", " ", "", "type")).toBe("")
  })

  it("allows a lone trailing space while typing so the next word can follow", () => {
    // before = "d" (end of a word), slot end after — a paste would strip this,
    // but live typing must keep it so "word " can become "word next".
    expect(sanitizeIdmlSlotInsertion(" ", "d", "", "type")).toBe(" ")
  })

  it("allows an ordinary single space typed between two words", () => {
    expect(sanitizeIdmlSlotInsertion(" ", "d", "n", "type")).toBe(" ")
  })
})
