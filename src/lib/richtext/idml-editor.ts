import { Extension, Node as TiptapNode, mergeAttributes } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin } from "@tiptap/pm/state"
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

/**
 * Concatenates only translator-owned (editable slot) text from a live IDML
 * editor document. IDML target cells retain their SOURCE text inside the
 * non-editable ("locked") protected slots, so text-direction auto-detection
 * must ignore those anchors — otherwise an RTL source forces an LTR target
 * editor to render right-to-left (AQU-740).
 */
export function idmlEditableText(doc: ProseMirrorNode): string {
  let text = ""
  doc.descendants((node) => {
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    if (node.attrs.editable === true) text += node.textContent
    return false
  })
  return text
}

/**
 * The HTML-string counterpart of {@link idmlEditableText}: pulls translator-owned
 * text out of a stored IDML target HTML by skipping every `contenteditable="false"`
 * (locked, source-carrying) slot. Used for read-side direction detection where no
 * live ProseMirror document is available (AQU-740).
 */
export function idmlEditableTextFromHtml(html: string | undefined | null): string {
  if (!html || typeof document === "undefined") return ""
  const template = document.createElement("template")
  template.innerHTML = html
  let text = ""
  for (const slot of template.content.querySelectorAll<HTMLElement>(
    "span[data-idml-protected=\"slot\"]",
  )) {
    if (slot.getAttribute("contenteditable") === "false") continue
    text += slot.textContent ?? ""
  }
  return text
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

export function idmlEditorExtensions(options: IdmlGuardOptions) {
  return [
    IdmlDocument,
    IdmlParagraph,
    IdmlSlot,
    IdmlToken,
    createIdmlGuardExtension(options),
  ]
}

export function idmlDiagnosticMessage(diagnostic: IdmlDiagnostic | undefined): string {
  return diagnosticMessage(diagnostic)
}
