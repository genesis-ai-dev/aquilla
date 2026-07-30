import { Extension, Node as TiptapNode, mergeAttributes } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, TextSelection, type Selection } from "@tiptap/pm/state"
import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlFormatMetadataV2,
  type IdmlProtectedTokenKind,
} from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"

export const IDML_PARAGRAPH_NODE_NAME = "idmlParagraph"
export const IDML_SLOT_NODE_NAME = "idmlSlot"
export const IDML_TOKEN_NODE_NAME = "idmlToken"

const IDML_TOKEN_KINDS = new Set<IdmlProtectedTokenKind>([
  "br",
  "tab",
  "inline-object",
  "variable",
  "cross-reference",
  "unknown",
])

export interface IdmlEditorContext {
  sourceHtml: string
  metadata: IdmlFormatMetadataV2
}

export type IdmlEditorConfiguration =
  | { kind: "ready"; context: IdmlEditorContext }
  | { kind: "error"; error: string }

export interface PreparedIdmlEditorContent {
  html: string
  error: string | null
}

interface IdmlGuardOptions {
  context: IdmlEditorContext
  onRejected: (diagnostic: IdmlDiagnostic) => void
}

/**
 * Returns a valid text-selection position inside an editable protected slot.
 * Empty inline slots have no ordinary text position for ProseMirror's click
 * resolver to discover, so callers may optionally name the clicked slot.
 */
export function idmlEditableSlotPosition(
  doc: ProseMirrorNode,
  requestedSlot?: number,
): number | null {
  let firstEditable: number | null = null
  let requested: number | null = null
  doc.descendants((node, position) => {
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    if (node.attrs.editable !== true) return false
    const contentPosition = position + 1
    firstEditable ??= contentPosition
    if (
      requestedSlot !== undefined
      && node.attrs.slot === requestedSlot
    ) {
      requested = contentPosition
    }
    return false
  })
  return requested ?? firstEditable
}

interface EditableSlotRange {
  /** First text position inside the slot. */
  start: number
  /** Last text position inside the slot (equals `start` while it is empty). */
  end: number
}

function editableSlotRanges(doc: ProseMirrorNode): EditableSlotRange[] {
  const ranges: EditableSlotRange[] = []
  doc.descendants((node, position) => {
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    if (node.attrs.editable === true) {
      ranges.push({ start: position + 1, end: position + 1 + node.content.size })
    }
    return false
  })
  return ranges
}

/**
 * AQU-740: maps a caret that landed *outside* every editable slot onto the
 * closest position inside one.
 *
 * An IDML paragraph is a sequence of inline slot/token nodes, so the paragraph
 * itself holds valid — but useless — text positions between them: the ones
 * `Selection.atStart` and a DOM "collapse to end of contents" focus both
 * resolve to. A caret parked there types into no slot at all, so every
 * keystroke fell back to the start of the first slot and the text came out
 * reversed.
 *
 * Returns null when the caret already sits in an editable slot (or the unit has
 * none), so callers can treat null as "leave the selection alone".
 */
export function nearestEditableIdmlSlotPosition(
  doc: ProseMirrorNode,
  position: number,
): number | null {
  const ranges = editableSlotRanges(doc)
  if (ranges.length === 0) return null
  if (ranges.some((range) => position >= range.start && position <= range.end)) return null
  // An untranslated unit starts at its first slot regardless of which end of
  // the paragraph the caret came from — translators read and type forwards.
  const first = ranges[0]
  if (!first) return null
  if (ranges.every((range) => range.end === range.start)) return first.start
  let best = first.start
  let bestDistance = Number.POSITIVE_INFINITY
  for (const range of ranges) {
    const candidate = position < range.start ? range.start : range.end
    const distance = Math.abs(position - candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/** The caret-inside-a-slot position a stray collapsed selection should take. */
function strayCaretPosition(doc: ProseMirrorNode, selection: Selection): number | null {
  if (!selection.empty || isEditableIdmlSelection(selection)) return null
  return nearestEditableIdmlSlotPosition(doc, selection.from)
}

export interface IdmlRange {
  from: number
  to: number
}

/**
 * The parts of `[from, to]` that lie in editable slot text — the only content a
 * translator owns. Protected tokens and locked slots fall out, so a selection
 * spanning them can be cleared without touching the IDML structure.
 */
export function editableIdmlRangesIn(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): IdmlRange[] {
  return editableSlotRanges(doc)
    .map((range) => ({ from: Math.max(from, range.start), to: Math.min(to, range.end) }))
    .filter((range) => range.from < range.to)
}

function editableSlotAt(
  doc: ProseMirrorNode,
  position: number,
): { start: number; node: ProseMirrorNode } | null {
  let found: { start: number; node: ProseMirrorNode } | null = null
  doc.descendants((node, nodePosition) => {
    if (found) return false
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    const start = nodePosition + 1
    if (
      node.attrs.editable === true
      && position >= start
      && position <= start + node.content.size
    ) {
      found = { start, node }
    }
    return false
  })
  return found
}

/**
 * A slot holds only text and hard breaks, so its content maps 1:1 onto a string
 * — one ProseMirror position per character, with a hard break counting as "\n".
 */
function slotPlainText(slot: ProseMirrorNode): string {
  let text = ""
  slot.forEach((child) => {
    text += child.isText ? child.text ?? "" : child.type.name === "hardBreak" ? "\n" : ""
  })
  return text
}

function segmentBoundaries(text: string, granularity: "grapheme" | "word"): number[] {
  const boundaries = [0]
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity })
    : null
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) {
      boundaries.push((boundaries[boundaries.length - 1] ?? 0) + segment.length)
    }
    return boundaries
  }
  // Code points keep surrogate pairs intact where Intl.Segmenter is missing.
  for (const codePoint of text) {
    boundaries.push((boundaries[boundaries.length - 1] ?? 0) + codePoint.length)
  }
  return boundaries
}

function lineBoundaries(text: string): number[] {
  const boundaries = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") boundaries.push(index + 1)
  }
  boundaries.push(text.length)
  return boundaries
}

/**
 * AQU-740: the translator-facing plain text of an IDML unit.
 *
 * Protected tokens still render as the whitespace they are (a tab token is a
 * tab), because inside a translation that whitespace is real. At the *edges* it
 * is not: a unit whose trailing slot is still untranslated ends on its protected
 * tab or line break, and QA read that structure as "extra whitespace in
 * translation" on text the translator never typed. Whitespace the translator
 * did type lives inside a slot and is always kept.
 */
export function idmlPlainText(doc: ProseMirrorNode): string {
  const parts: { text: string; structural: boolean }[] = []
  doc.descendants((node) => {
    if (node.type.name === IDML_SLOT_NODE_NAME) {
      parts.push({ text: slotPlainText(node), structural: false })
      return false
    }
    if (node.type.name === IDML_TOKEN_NODE_NAME) {
      const kind = node.attrs.tokenKind as IdmlProtectedTokenKind
      parts.push({ text: kind === "br" ? "\n" : kind === "tab" ? "\t" : "", structural: true })
      return false
    }
    return true
  })
  const droppable = (part: { text: string; structural: boolean } | undefined): boolean => (
    part !== undefined
    && (part.text.length === 0 || (part.structural && part.text.trim().length === 0))
  )
  while (droppable(parts[0])) parts.shift()
  while (droppable(parts[parts.length - 1])) parts.pop()
  return parts.map((part) => part.text).join("")
}

export type IdmlDeleteDirection = "backward" | "forward"
export type IdmlDeleteGranularity = "character" | "word" | "line"

/**
 * AQU-740: the range a Backspace/Delete press should remove, expressed in
 * ProseMirror positions and confined to one editable slot.
 *
 * IDML deletes cannot be left to the browser. Removing a slot's last character
 * makes the browser drop the emptied `<span>`, which reaches ProseMirror as
 * "an anchor disappeared" and is refused by the round-trip guard — so the final
 * character of every slot was undeletable. Computing the range ourselves keeps
 * the empty slot (legal, and how an untranslated unit already looks) and never
 * lets the DOM diverge from the document.
 *
 * Returns null when there is nothing deletable, e.g. Backspace at a slot's
 * start, where the neighbour is protected structure.
 */
export function idmlDeletionRange(
  doc: ProseMirrorNode,
  selection: Selection,
  direction: IdmlDeleteDirection,
  granularity: IdmlDeleteGranularity,
): IdmlRange | null {
  if (!selection.empty) return { from: selection.from, to: selection.to }
  const position = selection.from
  const slot = editableSlotAt(doc, position)
  if (!slot) return null
  const text = slotPlainText(slot.node)
  const offset = position - slot.start
  const boundaries = granularity === "line"
    ? lineBoundaries(text)
    : segmentBoundaries(text, granularity === "word" ? "word" : "grapheme")
  if (direction === "backward") {
    const previous = boundaries.filter((boundary) => boundary < offset).pop()
    if (previous === undefined) return null
    return { from: slot.start + previous, to: position }
  }
  const next = boundaries.find((boundary) => boundary > offset)
  if (next === undefined) return null
  return { from: position, to: slot.start + next }
}

export function isEditableIdmlSelection(selection: {
  $from: { depth: number; node: (depth: number) => ProseMirrorNode }
  $to: { depth: number; node: (depth: number) => ProseMirrorNode }
}): boolean {
  const editableSlotAt = (
    resolved: { depth: number; node: (depth: number) => ProseMirrorNode },
  ): ProseMirrorNode | null => {
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      const node = resolved.node(depth)
      if (node.type.name === IDML_SLOT_NODE_NAME) {
        return node.attrs.editable === true ? node : null
      }
    }
    return null
  }
  const fromSlot = editableSlotAt(selection.$from)
  const toSlot = editableSlotAt(selection.$to)
  return fromSlot !== null && fromSlot === toSlot
}

const IdmlDocument = TiptapNode.create({
  name: "doc",
  topNode: true,
  content: IDML_PARAGRAPH_NODE_NAME,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function hasIdmlCellMetadata(
  cellMetadata: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(
    cellMetadata
    && Object.prototype.hasOwnProperty.call(cellMetadata, "idml"),
  )
}

function diagnosticMessage(diagnostic: IdmlDiagnostic | undefined): string {
  if (!diagnostic) return "The IDML formatting anchors are invalid."
  switch (diagnostic.code) {
    case "ANCHOR_MISSING":
      return "This edit would remove protected InDesign formatting. Undo the change or re-import the IDML."
    case "ANCHOR_DUPLICATED":
      return "This edit would duplicate protected InDesign formatting. Paste text inside an existing formatting slot."
    case "ANCHOR_REORDERED":
      return "Protected InDesign formatting cannot be reordered."
    case "UNSUPPORTED_SCHEMA_VERSION":
      return "This IDML cell uses a newer metadata version. Update Aquilla before editing it."
    default:
      return diagnostic.message || "The IDML formatting anchors are invalid."
  }
}

/**
 * Resolves the persisted cell metadata into an editor contract. The presence
 * of any `metadata.idml` value opts the cell into fail-closed IDML handling:
 * malformed and future versions never fall back to the generic rich editor.
 */
export function resolveIdmlEditorConfiguration(
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string | undefined,
): IdmlEditorConfiguration | null {
  if (!hasIdmlCellMetadata(cellMetadata)) return null
  const raw = cellMetadata?.idml
  if (!isRecord(raw)) {
    return { kind: "error", error: "This IDML cell has invalid formatting metadata and must be repaired or re-imported." }
  }
  if (raw.version !== 2) {
    return {
      kind: "error",
      error: typeof raw.version === "number" && raw.version > 2
        ? "This IDML cell uses a newer metadata version. Update Aquilla before editing it."
        : "This IDML cell has unsupported formatting metadata and must be re-imported.",
    }
  }
  if (!sourceHtml) {
    return { kind: "error", error: "This IDML cell is missing its protected source HTML and must be re-imported." }
  }

  const metadata = raw as unknown as IdmlFormatMetadataV2
  const proof = validateIdmlTranslation(sourceHtml, sourceHtml, metadata)
  if (!proof.valid) {
    return { kind: "error", error: diagnosticMessage(proof.diagnostics[0]) }
  }
  return { kind: "ready", context: { sourceHtml, metadata } }
}

function emptyEditableSlots(sourceHtml: string, metadata: IdmlFormatMetadataV2): string {
  if (typeof document === "undefined") return sourceHtml
  const template = document.createElement("template")
  template.innerHTML = sourceHtml
  const editable = new Set(metadata.editableSlotIndexes)
  for (const slot of template.content.querySelectorAll<HTMLElement>(
    "span[data-idml-protected=\"slot\"][data-idml-slot]",
  )) {
    const index = Number(slot.getAttribute("data-idml-slot"))
    if (Number.isSafeInteger(index) && editable.has(index)) slot.replaceChildren()
  }
  const container = document.createElement("div")
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

/**
 * Hydrates only already-valid canonical target HTML. A genuinely untranslated
 * cell receives an empty copy of its source slots. Plain-only translated data
 * is never redistributed across formatting slots.
 */
export function prepareIdmlEditorContent(
  configuration: IdmlEditorConfiguration,
  targetHtml: string | undefined,
  targetPlain: string,
): PreparedIdmlEditorContent {
  if (configuration.kind === "error") return { html: "", error: configuration.error }
  const { context } = configuration
  const safeSource = sanitizeIdmlEditorHtml(context.sourceHtml)
  const sourceProof = validateIdmlTranslation(context.sourceHtml, safeSource, context.metadata)
  if (!sourceProof.valid) {
    return { html: "", error: diagnosticMessage(sourceProof.diagnostics[0]) }
  }

  let candidate: string
  if (targetHtml?.trim()) {
    candidate = sanitizeIdmlEditorHtml(targetHtml)
  } else if (targetPlain.length > 0) {
    return {
      html: emptyEditableSlots(safeSource, context.metadata),
      error:
        "This translated IDML cell has plain text but no formatting anchors. Re-import or repair it before editing.",
    }
  } else {
    candidate = emptyEditableSlots(safeSource, context.metadata)
  }

  const result = validateIdmlTranslation(context.sourceHtml, candidate, context.metadata)
  if (!result.valid) {
    return {
      html: emptyEditableSlots(safeSource, context.metadata),
      error: diagnosticMessage(result.diagnostics[0]),
    }
  }
  return { html: candidate, error: null }
}

/** Returns an actionable error for a commit that must be blocked. */
export function validateIdmlEditorCommit(
  configuration: IdmlEditorConfiguration | null,
  targetHtml: string,
): string | null {
  if (!configuration) return null
  if (configuration.kind === "error") return configuration.error
  const result = validateIdmlTranslation(
    configuration.context.sourceHtml,
    targetHtml,
    configuration.context.metadata,
  )
  return result.valid ? null : diagnosticMessage(result.diagnostics[0])
}

function integerAttribute(element: HTMLElement, name: string): number | false {
  const raw = element.getAttribute(name)
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return false
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : false
}

function exactAttributes(element: HTMLElement, expected: ReadonlySet<string>): boolean {
  return [...element.attributes].every((attribute) => expected.has(attribute.name))
    && [...expected].every((name) => element.hasAttribute(name))
}

function decorateIdmlStyleBoundary(element: HTMLElement, characterStyle: string): void {
  element.className = "idml-style-boundary"
  element.title = `InDesign character style: ${characterStyle}`
  const normalized = characterStyle.toLowerCase()
  element.style.fontWeight = /(?:bold|black|heavy)/.test(normalized) ? "700" : ""
  element.style.fontStyle = /(?:italic|oblique)/.test(normalized) ? "italic" : ""
  const decorations = [
    /underline/.test(normalized) ? "underline" : "",
    /(?:strike|strikethrough)/.test(normalized) ? "line-through" : "",
  ].filter(Boolean)
  element.style.textDecoration = decorations.join(" ")
}

const IdmlParagraph = TiptapNode.create({
  name: IDML_PARAGRAPH_NODE_NAME,
  group: "block",
  content: `( ${IDML_SLOT_NODE_NAME} | ${IDML_TOKEN_NODE_NAME} )*`,
  defining: true,
  isolating: true,
  priority: 1_000,

  addAttributes() {
    return { version: { default: 2 } }
  },

  parseHTML() {
    return [{
      tag: "p[data-idml-version]",
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        if (
          element.getAttribute("data-idml-version") !== "2"
          || !exactAttributes(element, new Set(["data-idml-version"]))
        ) return false
        return { version: 2 }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["p", { "data-idml-version": String(HTMLAttributes.version ?? 2) }, 0]
  },
})

const IdmlSlot = TiptapNode.create({
  name: IDML_SLOT_NODE_NAME,
  priority: 1_000,
  group: "inline",
  inline: true,
  content: "(text | hardBreak)*",
  marks: "",
  isolating: true,
  selectable: false,
  defining: true,

  addAttributes() {
    return {
      slot: { default: null },
      characterStyle: { default: null },
      editable: { default: true },
    }
  },

  parseHTML() {
    return [{
      tag: "span[data-idml-protected=\"slot\"]",
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        const editable = element.getAttribute("contenteditable") !== "false"
        const required = new Set([
          "data-idml-slot",
          "data-idml-character-style",
          "data-idml-protected",
          ...(editable ? [] : ["contenteditable"]),
        ])
        const slot = integerAttribute(element, "data-idml-slot")
        const characterStyle = element.getAttribute("data-idml-character-style")
        if (
          slot === false
          || !characterStyle
          || !exactAttributes(element, required)
          || (!editable && element.getAttribute("contenteditable") !== "false")
        ) return false
        return { slot, characterStyle, editable }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    const attributes: Record<string, string> = {
      "data-idml-slot": String(HTMLAttributes.slot),
      "data-idml-character-style": String(HTMLAttributes.characterStyle),
      "data-idml-protected": "slot",
    }
    if (HTMLAttributes.editable === false) attributes.contenteditable = "false"
    return ["span", attributes, 0]
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span")
      const render = (currentNode: ProseMirrorNode) => {
        const slot = currentNode.attrs.slot
        const characterStyle = String(currentNode.attrs.characterStyle ?? "")
        dom.setAttribute("data-idml-slot", String(slot))
        dom.setAttribute("data-idml-character-style", characterStyle)
        dom.setAttribute("data-idml-protected", "slot")
        if (currentNode.attrs.editable === false) dom.setAttribute("contenteditable", "false")
        else dom.removeAttribute("contenteditable")
        decorateIdmlStyleBoundary(dom, characterStyle)
      }
      render(node)
      return {
        dom,
        contentDOM: dom,
        update(updatedNode) {
          if (updatedNode.type.name !== IDML_SLOT_NODE_NAME) return false
          render(updatedNode)
          return true
        },
      }
    }
  },
})

const IdmlToken = TiptapNode.create({
  name: IDML_TOKEN_NODE_NAME,
  priority: 1_000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  isolating: true,

  addAttributes() {
    return {
      token: { default: null },
      tokenKind: { default: null },
    }
  },

  parseHTML() {
    const parse = (element: HTMLElement): false | Record<string, unknown> => {
      const token = integerAttribute(element, "data-idml-token")
      const tokenKind = element.getAttribute("data-idml-token-kind") as IdmlProtectedTokenKind | null
      if (
        token === false
        || !tokenKind
        || !IDML_TOKEN_KINDS.has(tokenKind)
        || element.getAttribute("contenteditable") !== "false"
        || !exactAttributes(element, new Set([
          "data-idml-token",
          "data-idml-token-kind",
          "data-idml-protected",
          "contenteditable",
        ]))
      ) return false
      return { token, tokenKind }
    }
    return [
      {
        tag: "span[data-idml-protected=\"token\"]",
        getAttrs: (element) => element instanceof HTMLElement ? parse(element) : false,
      },
      {
        tag: "br[data-idml-protected=\"token\"]",
        getAttrs: (element) => element instanceof HTMLElement ? parse(element) : false,
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const tokenKind = String(HTMLAttributes.tokenKind)
    const attributes = mergeAttributes({
      "data-idml-token": String(HTMLAttributes.token),
      "data-idml-token-kind": tokenKind,
      "data-idml-protected": "token",
      contenteditable: "false",
    })
    return tokenKind === "br" ? ["br", attributes] : ["span", attributes]
  },

  renderText({ node }) {
    switch (node.attrs.tokenKind as IdmlProtectedTokenKind) {
      case "br":
        return "\n"
      case "tab":
        return "\t"
      default:
        return ""
    }
  },
})

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function serializeSlotContent(slot: ProseMirrorNode): string | null {
  let html = ""
  for (let index = 0; index < slot.childCount; index += 1) {
    const child = slot.child(index)
    if (child.isText) {
      html += escapeText(child.text ?? "")
    } else if (child.type.name === "hardBreak") {
      html += "<br>"
    } else {
      return null
    }
  }
  return html
}

/**
 * Serializes the deliberately tiny IDML editor schema. It returns null rather
 * than allowing ProseMirror's generic DOM serializer to normalize or omit a
 * protected attribute.
 */
export function serializeIdmlEditorDocument(doc: ProseMirrorNode): string | null {
  if (doc.childCount !== 1) return null
  const paragraph = doc.child(0)
  if (paragraph.type.name !== IDML_PARAGRAPH_NODE_NAME || paragraph.attrs.version !== 2) return null
  let html = "<p data-idml-version=\"2\">"
  for (let index = 0; index < paragraph.childCount; index += 1) {
    const child = paragraph.child(index)
    if (child.type.name === IDML_SLOT_NODE_NAME) {
      const content = serializeSlotContent(child)
      if (
        content === null
        || !Number.isSafeInteger(child.attrs.slot)
        || typeof child.attrs.characterStyle !== "string"
        || child.attrs.characterStyle.length === 0
        || typeof child.attrs.editable !== "boolean"
      ) return null
      html += `<span data-idml-slot="${child.attrs.slot}" data-idml-character-style="${escapeText(child.attrs.characterStyle)}" data-idml-protected="slot"${child.attrs.editable ? "" : " contenteditable=\"false\""}>${content}</span>`
      continue
    }
    if (child.type.name !== IDML_TOKEN_NODE_NAME) return null
    const kind = child.attrs.tokenKind as IdmlProtectedTokenKind
    if (!Number.isSafeInteger(child.attrs.token) || !IDML_TOKEN_KINDS.has(kind)) return null
    const attributes = `data-idml-token="${child.attrs.token}" data-idml-token-kind="${kind}" data-idml-protected="token" contenteditable="false"`
    html += kind === "br" ? `<br ${attributes}>` : `<span ${attributes}></span>`
  }
  return `${html}</p>`
}

export function createIdmlGuardExtension({ context, onRejected }: IdmlGuardOptions): Extension {
  return Extension.create({
    name: "idmlTransactionGuard",
    priority: 10_000,
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction) {
          if (!transaction.docChanged) return true
          const html = serializeIdmlEditorDocument(transaction.doc)
          if (html === null) {
            onRejected({
              code: "ANCHOR_INVALID",
              severity: "error",
              message: "This edit would change the protected IDML document structure.",
            })
            return false
          }
          const result = validateIdmlTranslation(context.sourceHtml, html, context.metadata)
          if (result.valid) return true
          onRejected(result.diagnostics[0] ?? {
            code: "ANCHOR_INVALID",
            severity: "error",
            message: "This edit would change protected IDML formatting.",
          })
          return false
        },
      })]
    },
  })
}

/**
 * AQU-740: keeps a collapsed caret inside an editable slot. Programmatic focus
 * (the grid collapses a DOM range to the end of the editor's contents), arrow
 * keys leaving a slot, and clicks on a protected token all park the caret
 * between the paragraph's inline nodes, where typing has no slot to land in.
 * Range selections are left untouched so text can still be selected and copied
 * across protected anchors.
 */
export function createIdmlCaretExtension(): Extension {
  return Extension.create({
    name: "idmlCaretGuard",
    priority: 10_000,

    onCreate() {
      const { state, view } = this.editor
      const position = strayCaretPosition(state.doc, state.selection)
      if (position === null) return
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, position)))
    },

    addProseMirrorPlugins() {
      return [new Plugin({
        appendTransaction(_transactions, _oldState, newState) {
          const position = strayCaretPosition(newState.doc, newState.selection)
          if (position === null) return null
          return newState.tr.setSelection(TextSelection.create(newState.doc, position))
        },
      })]
    },
  })
}

export function idmlEditorExtensions(options: IdmlGuardOptions) {
  return [
    IdmlDocument,
    IdmlParagraph,
    IdmlSlot,
    IdmlToken,
    createIdmlCaretExtension(),
    createIdmlGuardExtension(options),
  ]
}

export function idmlDiagnosticMessage(diagnostic: IdmlDiagnostic | undefined): string {
  return diagnosticMessage(diagnostic)
}
