import { IdmlError } from "./errors.js"
import type {
  IdmlDiagnostic,
  IdmlFormatMetadataV2,
  IdmlProtectedToken,
  IdmlTextSlot,
  IdmlTranslationUnit,
  IdmlTranslationValidation,
} from "./types.js"

interface HtmlAttribute {
  readonly name: string
  readonly value: string
}

type HtmlToken =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "open"
      readonly name: string
      readonly attributes: readonly HtmlAttribute[]
      readonly selfClosing: boolean
    }
  | { readonly type: "close"; readonly name: string }

interface ParsedSlot {
  readonly index: number
  readonly characterStyleId: string
  readonly editable: boolean
  readonly text: string
}

interface ParsedProtectedToken {
  readonly index: number
  readonly kind: string
  readonly tagName: "br" | "span"
}

interface ParsedAnchorDocument {
  readonly slots: readonly ParsedSlot[]
  readonly tokens: readonly ParsedProtectedToken[]
  readonly sequence: readonly string[]
}

interface ParseResult {
  readonly document?: ParsedAnchorDocument
  readonly diagnostics: readonly IdmlDiagnostic[]
}

export interface LegacySegmentHtml {
  readonly segmentCount: number
  readonly paragraphStyle?: string
  readonly storyId?: string
  readonly slots: readonly {
    readonly index: number
    readonly characterStyleId: string
    readonly text: string
  }[]
  readonly breakBefore: readonly boolean[]
}

const SLOT_ATTRIBUTES = new Set([
  "contenteditable",
  "data-idml-character-style",
  "data-idml-protected",
  "data-idml-slot",
])
const TOKEN_ATTRIBUTES = new Set([
  "contenteditable",
  "data-idml-protected",
  "data-idml-token",
  "data-idml-token-kind",
])
const PROTECTED_TOKEN_KINDS = new Set([
  "br",
  "tab",
  "inline-object",
  "variable",
  "cross-reference",
  "unknown",
])
const LEGACY_PARAGRAPH_ATTRIBUTES = new Set([
  "class",
  "data-paragraph-style",
  "data-segment-count",
  "data-story-id",
])
const LEGACY_SLOT_ATTRIBUTES = new Set([
  "class",
  "data-character-style",
  "data-segment-index",
])
const LEGACY_EOC_ATTRIBUTES = new Set(["aria-hidden", "class", "data-eoc"])

function diagnostic(code: IdmlDiagnostic["code"], message: string): IdmlDiagnostic {
  return { code, severity: "error", message }
}

function fail(code: IdmlDiagnostic["code"], message: string): ParseResult {
  return { diagnostics: [diagnostic(code, message)] }
}

function isAsciiWhitespace(value: string): boolean {
  return /^[\t\n\f\r ]*$/.test(value)
}

function isWhitespaceTextToken(
  token: HtmlToken | undefined,
): token is Extract<HtmlToken, { readonly type: "text" }> {
  return token?.type === "text" && isAsciiWhitespace(token.value)
}

function codePointFromEntity(body: string): string | undefined {
  let value: number
  if (/^#x[0-9a-f]+$/i.test(body)) {
    value = Number.parseInt(body.slice(2), 16)
  } else if (/^#[0-9]+$/.test(body)) {
    value = Number.parseInt(body.slice(1), 10)
  } else {
    return undefined
  }
  if (
    !Number.isInteger(value)
    || !isXml10CodePoint(value)
  ) {
    return undefined
  }
  return String.fromCodePoint(value)
}

function isXml10CodePoint(value: number): boolean {
  return value === 0x09
    || value === 0x0a
    || value === 0x0d
    || (value >= 0x20 && value <= 0xd7ff)
    || (value >= 0xe000 && value <= 0xfffd)
    || (value >= 0x10000 && value <= 0x10ffff)
}

function isXml10Text(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || !isXml10CodePoint(codePoint)) return false
  }
  return true
}

export function decodeStrictHtmlText(value: string): string | undefined {
  let result = ""
  let cursor = 0
  while (cursor < value.length) {
    const ampersand = value.indexOf("&", cursor)
    if (ampersand < 0) {
      result += value.slice(cursor)
      break
    }
    result += value.slice(cursor, ampersand)
    const semicolon = value.indexOf(";", ampersand + 1)
    if (semicolon < 0) return undefined
    const entity = value.slice(ampersand + 1, semicolon)
    const named: Readonly<Record<string, string>> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: "\u00a0",
      quot: "\"",
    }
    const decoded = named[entity] ?? codePointFromEntity(entity)
    if (decoded === undefined) return undefined
    result += decoded
    cursor = semicolon + 1
  }
  return isXml10Text(result) ? result : undefined
}

export function escapeIdmlHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function escapeIdmlHtmlAttribute(value: string): string {
  return escapeIdmlHtmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderSlotText(value: string): string {
  return value
    .split("\n")
    .map(escapeIdmlHtmlText)
    .join("<br>")
}

function findTagEnd(html: string, start: number): number {
  let quote: "\"" | "'" | undefined
  for (let cursor = start + 1; cursor < html.length; cursor += 1) {
    const character = html[cursor]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "\"" || character === "'") {
      quote = character
    } else if (character === ">") {
      return cursor
    }
  }
  return -1
}

function parseAttributes(source: string): readonly HtmlAttribute[] | undefined {
  const attributes: HtmlAttribute[] = []
  const names = new Set<string>()
  let cursor = 0
  while (cursor < source.length) {
    while (cursor < source.length && /[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1
    if (cursor >= source.length) break

    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(cursor))
    if (!nameMatch) return undefined
    const name = nameMatch[0].toLowerCase()
    if (names.has(name)) return undefined
    names.add(name)
    cursor += nameMatch[0].length

    while (cursor < source.length && /[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1
    if (source[cursor] !== "=") return undefined
    cursor += 1
    while (cursor < source.length && /[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1

    const quote = source[cursor]
    if (quote !== "\"" && quote !== "'") return undefined
    cursor += 1
    const valueStart = cursor
    while (cursor < source.length && source[cursor] !== quote) cursor += 1
    if (cursor >= source.length) return undefined
    const decoded = decodeStrictHtmlText(source.slice(valueStart, cursor))
    if (decoded === undefined) return undefined
    attributes.push({ name, value: decoded })
    cursor += 1
  }
  return attributes
}

function tokenizeHtml(html: string): readonly HtmlToken[] | undefined {
  const tokens: HtmlToken[] = []
  let cursor = 0
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor)
    if (tagStart < 0) {
      tokens.push({ type: "text", value: html.slice(cursor) })
      break
    }
    if (tagStart > cursor) {
      tokens.push({ type: "text", value: html.slice(cursor, tagStart) })
    }
    const tagEnd = findTagEnd(html, tagStart)
    if (tagEnd < 0) return undefined
    let body = html.slice(tagStart + 1, tagEnd)
    if (
      body.length === 0
      || /[\t\n\f\r ]/.test(body[0] ?? "")
      || body.startsWith("!")
      || body.startsWith("?")
    ) {
      return undefined
    }

    if (body.startsWith("/")) {
      body = body.slice(1)
      if (/[\t\n\f\r ]/.test(body[0] ?? "")) return undefined
      body = body.trimEnd()
      if (!/^[A-Za-z][A-Za-z0-9:-]*$/.test(body)) return undefined
      tokens.push({ type: "close", name: body.toLowerCase() })
    } else {
      body = body.trimEnd()
      const selfClosing = body.endsWith("/")
      if (selfClosing) body = body.slice(0, -1).trimEnd()
      const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(body)
      if (!nameMatch) return undefined
      const name = nameMatch[0].toLowerCase()
      const attributes = parseAttributes(body.slice(nameMatch[0].length))
      if (!attributes) return undefined
      tokens.push({ type: "open", name, attributes, selfClosing })
    }
    cursor = tagEnd + 1
  }
  return tokens
}

function attributesToMap(
  attributes: readonly HtmlAttribute[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> | undefined {
  const result = new Map<string, string>()
  for (const attribute of attributes) {
    if (!allowed.has(attribute.name) || result.has(attribute.name)) return undefined
    result.set(attribute.name, attribute.value)
  }
  return result
}

function integerAttribute(attributes: ReadonlyMap<string, string>, name: string): number | undefined {
  const value = attributes.get(name)
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function renderProtectedToken(token: IdmlProtectedToken): string {
  const attributes = [
    `data-idml-token="${token.index}"`,
    `data-idml-token-kind="${escapeIdmlHtmlAttribute(token.kind)}"`,
    "data-idml-protected=\"token\"",
    "contenteditable=\"false\"",
  ].join(" ")
  return token.kind === "br"
    ? `<br ${attributes}>`
    : `<span ${attributes}></span>`
}

function renderSlot(slot: IdmlTextSlot): string {
  const contentEditable = slot.editable ? "" : " contenteditable=\"false\""
  return `<span data-idml-slot="${slot.index}" data-idml-character-style="${escapeIdmlHtmlAttribute(slot.characterStyleId)}" data-idml-protected="slot"${contentEditable}>${renderSlotText(slot.text)}</span>`
}

function orderedUnitAnchors(
  slots: readonly IdmlTextSlot[],
  protectedTokens: readonly IdmlProtectedToken[],
): readonly (IdmlTextSlot | IdmlProtectedToken)[] {
  const tokensByPosition = new Map<number, IdmlProtectedToken[]>()
  for (const token of protectedTokens) {
    const existing = tokensByPosition.get(token.position) ?? []
    existing.push(token)
    tokensByPosition.set(token.position, existing)
  }
  for (const tokens of tokensByPosition.values()) {
    tokens.sort((left, right) => left.index - right.index)
  }

  const ordered: (IdmlTextSlot | IdmlProtectedToken)[] = []
  for (let position = 0; position <= slots.length; position += 1) {
    ordered.push(...(tokensByPosition.get(position) ?? []))
    const slot = slots[position]
    if (slot) ordered.push(slot)
  }
  return ordered
}

function validateUnitForRendering(unit: IdmlTranslationUnit): {
  readonly slots: readonly IdmlTextSlot[]
  readonly protectedTokens: readonly IdmlProtectedToken[]
} {
  if (unit.metadata.version !== 2) {
    throw new IdmlError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported IDML metadata version ${String(unit.metadata.version)}`,
    )
  }
  const slots = [...unit.slots].sort((left, right) => left.index - right.index)
  if (
    slots.length !== unit.metadata.slotCount
    || slots.some((slot, index) => slot.index !== index)
    || slots.some((slot) => slot.characterStyleId.length === 0)
  ) {
    throw new IdmlError("ANCHOR_INVALID", "IDML slots must be unique and contiguous from zero")
  }
  const editableSlotIndexes = slots.filter((slot) => slot.editable).map((slot) => slot.index)
  if (
    editableSlotIndexes.length !== unit.metadata.editableSlotIndexes.length
    || editableSlotIndexes.some((index, position) => index !== unit.metadata.editableSlotIndexes[position])
  ) {
    throw new IdmlError("ANCHOR_INVALID", "IDML editable slot metadata does not match the unit slots")
  }

  const protectedTokens = [...unit.protectedTokens].sort((left, right) => left.index - right.index)
  if (
    protectedTokens.length !== unit.metadata.protectedTokenCount
    || protectedTokens.some((token, index) => token.index !== index)
    || protectedTokens.some((token) => (
      !Number.isInteger(token.position)
      || token.position < 0
      || token.position > slots.length
    ))
  ) {
    throw new IdmlError("ANCHOR_INVALID", "IDML protected token metadata is invalid")
  }
  const tokenDocumentOrder = orderedUnitAnchors(slots, protectedTokens)
    .filter((anchor): anchor is IdmlProtectedToken => !("characterStyleId" in anchor))
  if (tokenDocumentOrder.some((token, index) => token.index !== index)) {
    throw new IdmlError("ANCHOR_INVALID", "IDML protected token indexes must follow document order")
  }
  if (computeIdmlAnchorSequenceHash(slots, protectedTokens) !== unit.metadata.anchorSequenceHash) {
    throw new IdmlError("ANCHOR_INVALID", "IDML anchor sequence does not match its metadata hash")
  }
  return { slots, protectedTokens }
}

export function anchorIdentitySequence(
  slots: readonly Pick<IdmlTextSlot, "index" | "characterStyleId" | "editable">[],
  protectedTokens: readonly Pick<IdmlProtectedToken, "index" | "kind" | "position">[],
): readonly string[] {
  const slotCopies: IdmlTextSlot[] = slots
    .map((slot) => ({ ...slot, text: "" }))
    .sort((left, right) => left.index - right.index)
  const tokenCopies: IdmlProtectedToken[] = protectedTokens
    .map((token) => ({ ...token, xmlName: "" }))
    .sort((left, right) => left.index - right.index)
  return orderedUnitAnchors(slotCopies, tokenCopies).map((anchor) => (
    "characterStyleId" in anchor
      ? `slot:${anchor.index}:${anchor.editable ? "editable" : "locked"}:${anchor.characterStyleId}`
      : `token:${anchor.index}:${anchor.kind}`
  ))
}

export function sha256Hex(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  view.setUint32(paddedLength - 8, high)
  view.setUint32(paddedLength - 4, low)

  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  const rotateRight = (word: number, count: number): number => (
    (word >>> count) | (word << (32 - count))
  )

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0
      const previous2 = words[index - 2] ?? 0
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0
    }

    let a = hash[0] ?? 0
    let b = hash[1] ?? 0
    let c = hash[2] ?? 0
    let d = hash[3] ?? 0
    let e = hash[4] ?? 0
    let f = hash[5] ?? 0
    let g = hash[6] ?? 0
    let h = hash[7] ?? 0
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choose + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0
    hash[1] = ((hash[1] ?? 0) + b) >>> 0
    hash[2] = ((hash[2] ?? 0) + c) >>> 0
    hash[3] = ((hash[3] ?? 0) + d) >>> 0
    hash[4] = ((hash[4] ?? 0) + e) >>> 0
    hash[5] = ((hash[5] ?? 0) + f) >>> 0
    hash[6] = ((hash[6] ?? 0) + g) >>> 0
    hash[7] = ((hash[7] ?? 0) + h) >>> 0
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("")
}

export function computeIdmlAnchorSequenceHash(
  slots: readonly Pick<IdmlTextSlot, "index" | "characterStyleId" | "editable">[],
  protectedTokens: readonly Pick<IdmlProtectedToken, "index" | "kind" | "position">[],
): string {
  return sha256Hex(anchorIdentitySequence(slots, protectedTokens).join("\u0000"))
}

export function renderIdmlUnitHtml(unit: IdmlTranslationUnit): string {
  const { slots, protectedTokens } = validateUnitForRendering(unit)
  return `<p data-idml-version="2">${orderedUnitAnchors(slots, protectedTokens)
    .map((anchor) => (
      "characterStyleId" in anchor ? renderSlot(anchor) : renderProtectedToken(anchor)
    ))
    .join("")}</p>`
}

function parseAnchorDocument(html: string, metadata: IdmlFormatMetadataV2): ParseResult {
  const tokens = tokenizeHtml(html)
  if (!tokens) return fail("ANCHOR_INVALID", "IDML HTML is malformed")

  let cursor = 0
  while (cursor < tokens.length && isWhitespaceTextToken(tokens[cursor])) {
    cursor += 1
  }
  const paragraph = tokens[cursor]
  if (paragraph?.type !== "open" || paragraph.name !== "p" || paragraph.selfClosing) {
    return fail("ANCHOR_INVALID", "IDML HTML must contain one paragraph root")
  }
  const paragraphAttributes = attributesToMap(paragraph.attributes, new Set(["data-idml-version"]))
  if (!paragraphAttributes || paragraphAttributes.size !== 1) {
    return fail("ANCHOR_INVALID", "IDML paragraph attributes were changed")
  }
  const htmlVersion = integerAttribute(paragraphAttributes, "data-idml-version")
  if (htmlVersion !== 2) {
    return fail(
      htmlVersion !== undefined && htmlVersion > 2
        ? "UNSUPPORTED_SCHEMA_VERSION"
        : "ANCHOR_INVALID",
      `Unsupported IDML HTML version ${String(htmlVersion)}`,
    )
  }
  cursor += 1

  const slots: ParsedSlot[] = []
  const protectedTokens: ParsedProtectedToken[] = []
  const sequence: string[] = []
  const slotIndexes = new Set<number>()
  const tokenIndexes = new Set<number>()
  let foundParagraphClose = false

  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token?.type === "close" && token.name === "p") {
      cursor += 1
      foundParagraphClose = true
      break
    }
    if (token?.type === "text") {
      return fail("ANCHOR_INVALID", "Text outside an IDML slot is not allowed")
    }
    if (token?.type !== "open") {
      return fail("ANCHOR_INVALID", "Unexpected closing tag in IDML HTML")
    }

    if (token.name === "span") {
      const slotAttributes = attributesToMap(token.attributes, SLOT_ATTRIBUTES)
      const protectedKind = slotAttributes?.get("data-idml-protected")
      if (slotAttributes && protectedKind === "slot") {
        if (token.selfClosing) return fail("ANCHOR_INVALID", "IDML slot spans cannot be self-closing")
        const index = integerAttribute(slotAttributes, "data-idml-slot")
        const characterStyleId = slotAttributes.get("data-idml-character-style")
        if (
          index === undefined
          || characterStyleId === undefined
          || characterStyleId.length === 0
          || (slotAttributes.size !== 3 && slotAttributes.size !== 4)
        ) {
          return fail("ANCHOR_INVALID", "IDML slot attributes are incomplete")
        }
        if (slotIndexes.has(index)) {
          return fail("ANCHOR_DUPLICATED", `IDML slot ${index} is duplicated`)
        }
        slotIndexes.add(index)
        const editable = metadata.editableSlotIndexes.includes(index)
        const contentEditable = slotAttributes.get("contenteditable")
        if (
          (editable && contentEditable !== undefined)
          || (!editable && contentEditable !== "false")
        ) {
          return fail("ANCHOR_INVALID", `IDML slot ${index} editability was changed`)
        }

        cursor += 1
        let text = ""
        let foundClose = false
        while (cursor < tokens.length) {
          const content = tokens[cursor]
          if (content?.type === "close" && content.name === "span") {
            foundClose = true
            cursor += 1
            break
          }
          if (content?.type === "text") {
            const decoded = decodeStrictHtmlText(content.value)
            if (decoded === undefined) {
              return fail("ANCHOR_INVALID", `IDML slot ${index} contains an invalid entity`)
            }
            text += decoded
            cursor += 1
            continue
          }
          if (
            content?.type === "open"
            && content.name === "br"
            && content.attributes.length === 0
          ) {
            text += "\n"
            cursor += 1
            continue
          }
          return fail("ANCHOR_INVALID", `IDML slot ${index} contains unsupported markup`)
        }
        if (!foundClose) return fail("ANCHOR_INVALID", `IDML slot ${index} is not closed`)
        slots.push({ index, characterStyleId, editable, text })
        sequence.push(`slot:${index}:${editable ? "editable" : "locked"}:${characterStyleId}`)
        continue
      }

      const protectedAttributes = attributesToMap(token.attributes, TOKEN_ATTRIBUTES)
      if (
        !protectedAttributes
        || protectedAttributes.get("data-idml-protected") !== "token"
      ) {
        return fail("ANCHOR_INVALID", "Unknown span markup is not allowed")
      }
      if (token.selfClosing) return fail("ANCHOR_INVALID", "Protected token spans cannot be self-closing")
      const index = integerAttribute(protectedAttributes, "data-idml-token")
      const kind = protectedAttributes.get("data-idml-token-kind")
      if (
        index === undefined
        || !kind
        || kind === "br"
        || !PROTECTED_TOKEN_KINDS.has(kind)
        || protectedAttributes.get("contenteditable") !== "false"
        || protectedAttributes.size !== 4
      ) {
        return fail("ANCHOR_INVALID", "Protected token attributes are incomplete")
      }
      if (tokenIndexes.has(index)) {
        return fail("ANCHOR_DUPLICATED", `IDML protected token ${index} is duplicated`)
      }
      tokenIndexes.add(index)
      const close = tokens[cursor + 1]
      if (close?.type !== "close" || close.name !== "span") {
        return fail("ANCHOR_INVALID", `IDML protected token ${index} must be empty`)
      }
      protectedTokens.push({ index, kind, tagName: "span" })
      sequence.push(`token:${index}:${kind}`)
      cursor += 2
      continue
    }

    if (token.name === "br") {
      const protectedAttributes = attributesToMap(token.attributes, TOKEN_ATTRIBUTES)
      if (
        !protectedAttributes
        || protectedAttributes.get("data-idml-protected") !== "token"
      ) {
        return fail("ANCHOR_INVALID", "A bare line break is only allowed inside an IDML slot")
      }
      const index = integerAttribute(protectedAttributes, "data-idml-token")
      const kind = protectedAttributes.get("data-idml-token-kind")
      if (
        index === undefined
        || kind !== "br"
        || !PROTECTED_TOKEN_KINDS.has(kind)
        || protectedAttributes.get("contenteditable") !== "false"
        || protectedAttributes.size !== 4
      ) {
        return fail("ANCHOR_INVALID", "Protected line-break token attributes are invalid")
      }
      if (tokenIndexes.has(index)) {
        return fail("ANCHOR_DUPLICATED", `IDML protected token ${index} is duplicated`)
      }
      tokenIndexes.add(index)
      protectedTokens.push({ index, kind, tagName: "br" })
      sequence.push(`token:${index}:${kind}`)
      cursor += 1
      continue
    }
    return fail("ANCHOR_INVALID", `Unknown IDML element <${token.name}>`)
  }

  if (!foundParagraphClose) return fail("ANCHOR_INVALID", "IDML paragraph is not closed")
  while (cursor < tokens.length && isWhitespaceTextToken(tokens[cursor])) {
    cursor += 1
  }
  if (cursor !== tokens.length) {
    return fail("ANCHOR_INVALID", "IDML HTML must contain exactly one paragraph")
  }
  return {
    document: { slots, tokens: protectedTokens, sequence },
    diagnostics: [],
  }
}

function validateMetadata(metadata: IdmlFormatMetadataV2): readonly IdmlDiagnostic[] {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [diagnostic("ANCHOR_INVALID", "IDML metadata must be an object")]
  }
  const candidate = metadata as unknown as {
    readonly version?: unknown
    readonly slotCount?: unknown
    readonly editableSlotIndexes?: unknown
    readonly protectedTokenCount?: unknown
    readonly anchorSequenceHash?: unknown
  }
  const rawVersion = candidate.version
  if (typeof rawVersion !== "number" || rawVersion !== 2) {
    return [diagnostic(
      typeof rawVersion === "number" && rawVersion > 2
        ? "UNSUPPORTED_SCHEMA_VERSION"
        : "ANCHOR_INVALID",
      `Unsupported IDML metadata version ${String(rawVersion)}`,
    )]
  }
  if (
    !Number.isSafeInteger(candidate.slotCount)
    || typeof candidate.slotCount !== "number"
    || candidate.slotCount < 0
  ) {
    return [diagnostic("ANCHOR_INVALID", "IDML slot count is invalid")]
  }
  if (
    !Number.isSafeInteger(candidate.protectedTokenCount)
    || typeof candidate.protectedTokenCount !== "number"
    || candidate.protectedTokenCount < 0
  ) {
    return [diagnostic("ANCHOR_INVALID", "IDML protected token count is invalid")]
  }
  if (!Array.isArray(candidate.editableSlotIndexes)) {
    return [diagnostic("ANCHOR_INVALID", "IDML editable slot indexes are invalid")]
  }
  if (
    typeof candidate.anchorSequenceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.anchorSequenceHash)
  ) {
    return [diagnostic("ANCHOR_INVALID", "IDML anchor sequence hash is invalid")]
  }
  const seen = new Set<number>()
  let previousIndex = -1
  for (const index of candidate.editableSlotIndexes) {
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= candidate.slotCount
      || seen.has(index)
      || index <= previousIndex
    ) {
      return [diagnostic("ANCHOR_INVALID", "IDML editable slot indexes are invalid")]
    }
    seen.add(index)
    previousIndex = index
  }
  return []
}

function anchorMap(document: ParsedAnchorDocument): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  for (const identity of document.sequence) {
    map.set(identity, (map.get(identity) ?? 0) + 1)
  }
  return map
}

function compareDocuments(
  source: ParsedAnchorDocument,
  target: ParsedAnchorDocument,
  metadata: IdmlFormatMetadataV2,
): readonly IdmlDiagnostic[] {
  if (source.slots.length !== metadata.slotCount) {
    return [diagnostic(
      "ANCHOR_MISSING",
      `Source IDML HTML has ${source.slots.length} slots; expected ${metadata.slotCount}`,
    )]
  }
  if (source.tokens.length !== metadata.protectedTokenCount) {
    return [diagnostic(
      "ANCHOR_MISSING",
      `Source IDML HTML has ${source.tokens.length} protected tokens; expected ${metadata.protectedTokenCount}`,
    )]
  }
  if (
    source.slots.some((slot, index) => slot.index !== index)
    || source.tokens.some((token, index) => token.index !== index)
  ) {
    return [diagnostic("ANCHOR_INVALID", "Source IDML anchor indexes must be contiguous from zero")]
  }
  const sourceHash = sha256Hex(source.sequence.join("\u0000"))
  if (sourceHash !== metadata.anchorSequenceHash) {
    return [diagnostic("ANCHOR_INVALID", "IDML anchor sequence does not match its metadata hash")]
  }

  if (target.slots.length < source.slots.length || target.tokens.length < source.tokens.length) {
    return [diagnostic("ANCHOR_MISSING", "The translation is missing one or more protected IDML anchors")]
  }
  if (target.slots.length > source.slots.length || target.tokens.length > source.tokens.length) {
    return [diagnostic("ANCHOR_DUPLICATED", "The translation contains extra protected IDML anchors")]
  }

  const sourceMap = anchorMap(source)
  const targetMap = anchorMap(target)
  if (
    sourceMap.size !== targetMap.size
    || [...sourceMap].some(([identity, count]) => targetMap.get(identity) !== count)
  ) {
    return [diagnostic("ANCHOR_INVALID", "The translation changed an IDML anchor identity or style")]
  }
  if (source.sequence.some((identity, index) => target.sequence[index] !== identity)) {
    return [diagnostic("ANCHOR_REORDERED", "The translation reordered protected IDML anchors")]
  }
  for (let index = 0; index < source.tokens.length; index += 1) {
    if (source.tokens[index]?.tagName !== target.tokens[index]?.tagName) {
      return [diagnostic("ANCHOR_INVALID", "The translation changed a protected IDML token element")]
    }
  }
  for (const sourceSlot of source.slots) {
    if (!sourceSlot.editable) {
      const targetSlot = target.slots.find((slot) => slot.index === sourceSlot.index)
      if (targetSlot?.text !== sourceSlot.text) {
        return [diagnostic("ANCHOR_INVALID", `Locked IDML slot ${sourceSlot.index} was changed`)]
      }
    }
  }
  return []
}

export function validateIdmlTranslation(
  sourceHtml: string,
  targetHtml: string,
  metadata: IdmlFormatMetadataV2,
): IdmlTranslationValidation {
  const metadataDiagnostics = validateMetadata(metadata)
  if (metadataDiagnostics.length > 0) {
    return { valid: false, diagnostics: metadataDiagnostics, slots: [] }
  }

  const source = parseAnchorDocument(sourceHtml, metadata)
  if (!source.document) {
    return { valid: false, diagnostics: source.diagnostics, slots: [] }
  }
  const target = parseAnchorDocument(targetHtml, metadata)
  if (!target.document) {
    return { valid: false, diagnostics: target.diagnostics, slots: [] }
  }
  const diagnostics = compareDocuments(source.document, target.document, metadata)
  if (diagnostics.length > 0) return { valid: false, diagnostics, slots: [] }

  const slotValues = Array.from({ length: metadata.slotCount }, () => "")
  for (const slot of target.document.slots) slotValues[slot.index] = slot.text
  return { valid: true, diagnostics: [], slots: slotValues }
}

export function parseLegacySegmentIndexHtml(html: string): LegacySegmentHtml | undefined {
  const tokens = tokenizeHtml(html)
  if (!tokens) return undefined
  let cursor = 0
  while (cursor < tokens.length && isWhitespaceTextToken(tokens[cursor])) {
    cursor += 1
  }
  const paragraph = tokens[cursor]
  if (paragraph?.type !== "open" || paragraph.name !== "p" || paragraph.selfClosing) return undefined
  const paragraphAttributes = attributesToMap(paragraph.attributes, LEGACY_PARAGRAPH_ATTRIBUTES)
  if (!paragraphAttributes) return undefined
  const segmentCount = integerAttribute(paragraphAttributes, "data-segment-count")
  if (segmentCount === undefined) return undefined
  const paragraphClass = paragraphAttributes.get("class")
  if (paragraphClass !== undefined && paragraphClass !== "indesign-paragraph") return undefined
  cursor += 1

  const slots: {
    index: number
    characterStyleId: string
    text: string
  }[] = []
  const breakBefore = Array.from({ length: segmentCount }, () => false)
  const seen = new Set<number>()
  let pendingBreak = false
  let pendingBoundary = false
  let foundParagraphClose = false
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token?.type === "close" && token.name === "p") {
      cursor += 1
      foundParagraphClose = true
      break
    }
    if (token?.type === "text") return undefined
    if (token?.type !== "open") return undefined

    if (token.name === "br") {
      const attributes = attributesToMap(token.attributes, LEGACY_EOC_ATTRIBUTES)
      if (
        !attributes
        || attributes.get("class") !== "idml-eoc"
        || attributes.get("data-eoc") !== "1"
        || attributes.size !== 2
        || pendingBoundary
      ) {
        return undefined
      }
      pendingBreak = true
      pendingBoundary = true
      cursor += 1
      continue
    }

    if (token.name !== "span" || token.selfClosing) return undefined
    const eocAttributes = attributesToMap(token.attributes, LEGACY_EOC_ATTRIBUTES)
    if (eocAttributes?.get("class") === "idml-eoc") {
      if (
        eocAttributes.get("data-eoc") !== "1"
        || eocAttributes.get("aria-hidden") !== "true"
        || eocAttributes.size !== 3
        || pendingBoundary
      ) {
        return undefined
      }
      const close = tokens[cursor + 1]
      if (close?.type !== "close" || close.name !== "span") return undefined
      pendingBreak = false
      pendingBoundary = true
      cursor += 2
      continue
    }

    const attributes = attributesToMap(token.attributes, LEGACY_SLOT_ATTRIBUTES)
    const index = attributes ? integerAttribute(attributes, "data-segment-index") : undefined
    const characterStyleId = attributes?.get("data-character-style")
    if (
      !attributes
      || attributes.get("class") !== "idml-segment"
      || index === undefined
      || index >= segmentCount
      || !characterStyleId
      || attributes.size !== 3
      || seen.has(index)
      || (slots.length === 0 ? pendingBoundary : !pendingBoundary)
    ) {
      return undefined
    }
    seen.add(index)
    cursor += 1
    let text = ""
    let foundClose = false
    while (cursor < tokens.length) {
      const content = tokens[cursor]
      if (content?.type === "close" && content.name === "span") {
        cursor += 1
        foundClose = true
        break
      }
      if (content?.type === "text") {
        const decoded = decodeStrictHtmlText(content.value)
        if (decoded === undefined) return undefined
        text += decoded
        cursor += 1
        continue
      }
      if (content?.type === "open" && content.name === "br" && content.attributes.length === 0) {
        text += "\n"
        cursor += 1
        continue
      }
      return undefined
    }
    if (!foundClose) return undefined
    breakBefore[index] = pendingBreak
    pendingBreak = false
    pendingBoundary = false
    slots.push({ index, characterStyleId, text })
  }

  if (!foundParagraphClose) return undefined
  while (cursor < tokens.length && isWhitespaceTextToken(tokens[cursor])) {
    cursor += 1
  }
  if (cursor !== tokens.length || pendingBreak || pendingBoundary) return undefined
  return {
    segmentCount,
    paragraphStyle: paragraphAttributes.get("data-paragraph-style"),
    storyId: paragraphAttributes.get("data-story-id"),
    slots,
    breakBefore,
  }
}
