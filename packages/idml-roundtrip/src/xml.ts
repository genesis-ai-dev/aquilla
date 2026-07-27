import { IdmlError } from "./errors.js"
import type { IdmlDiagnostic } from "./types.js"

export interface XmlAttribute {
  readonly name: string
  readonly value: string
  readonly start: number
  readonly end: number
  readonly valueStart: number
  readonly valueEnd: number
}

export interface XmlTextNode {
  readonly kind: "text" | "cdata"
  readonly value: string
  readonly start: number
  readonly end: number
  readonly parent: XmlElement
}

export interface XmlElement {
  readonly kind: "element"
  readonly name: string
  readonly localName: string
  readonly attributes: readonly XmlAttribute[]
  readonly children: readonly XmlNode[]
  readonly parent: XmlElement | null
  readonly start: number
  readonly openEnd: number
  readonly closeStart: number
  readonly end: number
  readonly selfClosing: boolean
}

export type XmlNode = XmlElement | XmlTextNode

export interface XmlDocument {
  readonly source: string
  readonly root: XmlElement
}

interface MutableElement {
  kind: "element"
  name: string
  localName: string
  attributes: XmlAttribute[]
  children: XmlNode[]
  parent: MutableElement | null
  start: number
  openEnd: number
  closeStart: number
  end: number
  selfClosing: boolean
}

const XML_DECLARATION_ENCODING = /^utf-?8$/i

export function decodeXmlBytes(bytes: Uint8Array, memberPath?: string): string {
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw xmlError("MALFORMED_XML", "XML member is not valid UTF-8", memberPath)
  }

  const declaration = source.match(/^\uFEFF?\s*<\?xml\s+([\s\S]*?)\?>/i)
  if (declaration) {
    const encoding = parseDeclarationAttributes(declaration[1] ?? "", memberPath).get("encoding")
    if (encoding && !XML_DECLARATION_ENCODING.test(encoding)) {
      throw xmlError(
        "UNSAFE_XML_DECLARATION",
        `Unsupported XML encoding declaration "${encoding}"`,
        memberPath,
      )
    }
  }
  return source
}

export function parseXml(source: string, memberPath?: string): XmlDocument {
  const stack: MutableElement[] = []
  let root: MutableElement | null = null
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0
  let sawXmlDeclaration = false
  let sawNonDeclarationContent = false

  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const start = cursor
      const next = source.indexOf("<", cursor)
      cursor = next === -1 ? source.length : next
      const raw = source.slice(start, cursor)
      if (raw.includes("]]>")) {
        throw xmlError(
          "MALFORMED_XML",
          "The sequence ']]>' is not allowed in XML character data",
          memberPath,
        )
      }
      const value = decodeXmlEntities(raw, memberPath)
      validateXmlCharacters(value, memberPath)
      const parent = stack.at(-1)
      if (parent) {
        parent.children.push({ kind: "text", value, start, end: cursor, parent })
      } else if (raw.trim().length > 0) {
        throw xmlError("MALFORMED_XML", "Text is not allowed outside the document element", memberPath)
      }
      if (raw.trim().length > 0) sawNonDeclarationContent = true
      continue
    }

    if (source.startsWith("<!--", cursor)) {
      const endMarker = source.indexOf("-->", cursor + 4)
      if (endMarker === -1) {
        throw xmlError("MALFORMED_XML", "Unterminated XML comment", memberPath)
      }
      const comment = source.slice(cursor + 4, endMarker)
      if (comment.includes("--") || comment.endsWith("-")) {
        throw xmlError("MALFORMED_XML", "Invalid XML comment", memberPath)
      }
      validateXmlCharacters(comment, memberPath)
      cursor = endMarker + 3
      sawNonDeclarationContent = true
      continue
    }

    if (source.startsWith("<![CDATA[", cursor)) {
      const endMarker = source.indexOf("]]>", cursor + 9)
      if (endMarker === -1) {
        throw xmlError("MALFORMED_XML", "Unterminated CDATA section", memberPath)
      }
      const parent = stack.at(-1)
      if (!parent) {
        throw xmlError("MALFORMED_XML", "CDATA is not allowed outside the document element", memberPath)
      }
      const value = source.slice(cursor + 9, endMarker)
      validateXmlCharacters(value, memberPath)
      parent.children.push({
        kind: "cdata",
        value,
        start: cursor,
        end: endMarker + 3,
        parent,
      })
      cursor = endMarker + 3
      sawNonDeclarationContent = true
      continue
    }

    if (source.startsWith("<?", cursor)) {
      const endMarker = source.indexOf("?>", cursor + 2)
      if (endMarker === -1) {
        throw xmlError("MALFORMED_XML", "Unterminated processing instruction", memberPath)
      }
      let bodyCursor = cursor + 2
      const target = readName(source, bodyCursor, memberPath)
      bodyCursor = target.end
      const body = source.slice(bodyCursor, endMarker)
      if (target.name.toLowerCase() === "xml") {
        const declarationStart = source.charCodeAt(0) === 0xfeff ? 1 : 0
        if (
          cursor !== declarationStart ||
          sawXmlDeclaration ||
          sawNonDeclarationContent ||
          root ||
          stack.length > 0
        ) {
          throw xmlError("MALFORMED_XML", "XML declaration must be the first declaration", memberPath)
        }
        parseDeclarationAttributes(body, memberPath)
        sawXmlDeclaration = true
      } else if (target.name.toLowerCase().startsWith("xml")) {
        throw xmlError("MALFORMED_XML", "Processing instruction target may not begin with xml", memberPath)
      }
      cursor = endMarker + 2
      if (target.name.toLowerCase() !== "xml") sawNonDeclarationContent = true
      continue
    }

    if (source.startsWith("<!", cursor)) {
      throw xmlError(
        "UNSAFE_XML_DECLARATION",
        "DTD, ENTITY, and other markup declarations are not allowed in IDML XML",
        memberPath,
      )
    }

    if (source.startsWith("</", cursor)) {
      let closeCursor = cursor + 2
      const closing = readName(source, closeCursor, memberPath)
      closeCursor = skipWhitespace(source, closing.end)
      if (source[closeCursor] !== ">") {
        throw xmlError("MALFORMED_XML", "Malformed closing tag", memberPath)
      }
      const current = stack.pop()
      if (!current || current.name !== closing.name) {
        const expected = current ? `</${current.name}>` : "no closing tag"
        throw xmlError(
          "MALFORMED_XML",
          `Unexpected </${closing.name}>; expected ${expected}`,
          memberPath,
        )
      }
      current.closeStart = cursor
      current.end = closeCursor + 1
      cursor = closeCursor + 1
      sawNonDeclarationContent = true
      continue
    }

    const elementStart = cursor
    let openCursor = cursor + 1
    const elementName = readName(source, openCursor, memberPath)
    openCursor = elementName.end
    const attributes: XmlAttribute[] = []
    const attributeNames = new Set<string>()
    let selfClosing = false
    let parsedAttribute = false

    while (openCursor < source.length) {
      const beforeWhitespace = openCursor
      openCursor = skipWhitespace(source, openCursor)
      if (
        parsedAttribute &&
        openCursor === beforeWhitespace &&
        source[openCursor] !== ">" &&
        !source.startsWith("/>", openCursor)
      ) {
        throw xmlError("MALFORMED_XML", "XML attributes must be separated by whitespace", memberPath)
      }
      if (source.startsWith("/>", openCursor)) {
        selfClosing = true
        openCursor += 2
        break
      }
      if (source[openCursor] === ">") {
        openCursor += 1
        break
      }
      if (openCursor >= source.length) {
        throw xmlError("MALFORMED_XML", `Unterminated <${elementName.name}> tag`, memberPath)
      }

      const attributeStart = openCursor
      const attributeName = readName(source, openCursor, memberPath)
      openCursor = skipWhitespace(source, attributeName.end)
      if (source[openCursor] !== "=") {
        throw xmlError(
          "MALFORMED_XML",
          `Attribute ${attributeName.name} is missing '='`,
          memberPath,
        )
      }
      openCursor = skipWhitespace(source, openCursor + 1)
      const quote = source[openCursor]
      if (quote !== `"` && quote !== `'`) {
        throw xmlError(
          "MALFORMED_XML",
          `Attribute ${attributeName.name} must use quotes`,
          memberPath,
        )
      }
      const valueStart = openCursor + 1
      const valueEnd = source.indexOf(quote, valueStart)
      if (valueEnd === -1) {
        throw xmlError(
          "MALFORMED_XML",
          `Attribute ${attributeName.name} has no closing quote`,
          memberPath,
        )
      }
      const rawValue = source.slice(valueStart, valueEnd)
      if (rawValue.includes("<")) {
        throw xmlError("MALFORMED_XML", "Attribute values may not contain '<'", memberPath)
      }
      if (attributeNames.has(attributeName.name)) {
        throw xmlError(
          "MALFORMED_XML",
          `Duplicate attribute ${attributeName.name}`,
          memberPath,
        )
      }
      attributeNames.add(attributeName.name)
      const value = decodeXmlEntities(rawValue, memberPath)
      validateXmlCharacters(value, memberPath)
      openCursor = valueEnd + 1
      attributes.push({
        name: attributeName.name,
        value,
        start: attributeStart,
        end: openCursor,
        valueStart,
        valueEnd,
      })
      parsedAttribute = true
    }

    if (openCursor > source.length || (!selfClosing && source[openCursor - 1] !== ">")) {
      throw xmlError("MALFORMED_XML", `Unterminated <${elementName.name}> tag`, memberPath)
    }

    const parent = stack.at(-1) ?? null
    if (!parent && root) {
      throw xmlError("MALFORMED_XML", "XML document contains more than one root element", memberPath)
    }
    const element: MutableElement = {
      kind: "element",
      name: elementName.name,
      localName: localName(elementName.name),
      attributes,
      children: [],
      parent,
      start: elementStart,
      openEnd: openCursor,
      closeStart: selfClosing ? openCursor : -1,
      end: selfClosing ? openCursor : -1,
      selfClosing,
    }
    if (parent) parent.children.push(element as XmlElement)
    else root = element
    if (!selfClosing) stack.push(element)
    cursor = openCursor
    sawNonDeclarationContent = true
  }

  if (stack.length > 0) {
    const current = stack.at(-1)
    throw xmlError("MALFORMED_XML", `Unclosed <${current?.name ?? "unknown"}> element`, memberPath)
  }
  if (!root) {
    throw xmlError("MALFORMED_XML", "XML document has no root element", memberPath)
  }

  return { source, root: root as XmlElement }
}

export function getAttribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find(
    (attribute) => attribute.name === name || localName(attribute.name) === name,
  )?.value
}

export function elementDescendants(
  element: XmlElement,
  predicate?: (candidate: XmlElement) => boolean,
): XmlElement[] {
  const result: XmlElement[] = []
  const visit = (candidate: XmlElement): void => {
    if (!predicate || predicate(candidate)) result.push(candidate)
    for (const child of candidate.children) {
      if (child.kind === "element") visit(child)
    }
  }
  visit(element)
  return result
}

export function nearestAncestor(
  element: XmlElement,
  predicate: (candidate: XmlElement) => boolean,
): XmlElement | null {
  let current = element.parent
  while (current) {
    if (predicate(current)) return current
    current = current.parent
  }
  return null
}

export function elementPath(element: XmlElement): string {
  const segments: string[] = []
  let current: XmlElement | null = element
  while (current) {
    let index = 1
    if (current.parent) {
      for (const sibling of current.parent.children) {
        if (sibling === current) break
        if (sibling.kind === "element" && sibling.name === current.name) index += 1
      }
    }
    segments.push(`${current.name}[${index}]`)
    current = current.parent
  }
  return `/${segments.reverse().join("/")}`
}

export function resolveElementPath(document: XmlDocument, path: string): XmlElement | null {
  const rawSegments = path.split("/").filter(Boolean)
  if (rawSegments.length === 0) return null
  const rootSegment = rawSegments[0]
  const rootMatch = rootSegment?.match(/^([A-Za-z_:][A-Za-z0-9_.:-]*)\[(\d+)\]$/)
  if (!rootMatch || rootMatch[1] !== document.root.name || rootMatch[2] !== "1") return null
  let current: XmlElement = document.root

  for (let segmentIndex = 1; segmentIndex < rawSegments.length; segmentIndex += 1) {
    const segment = rawSegments[segmentIndex]
    const match = segment?.match(/^([A-Za-z_:][A-Za-z0-9_.:-]*)\[(\d+)\]$/)
    if (!match) return null
    const name = match[1]
    const index = Number.parseInt(match[2] ?? "", 10)
    if (!name || index < 1) return null
    let seen = 0
    let found: XmlElement | null = null
    for (const child of current.children) {
      if (child.kind !== "element" || child.name !== name) continue
      seen += 1
      if (seen === index) {
        found = child
        break
      }
    }
    if (!found) return null
    current = found
  }
  return current
}

export function elementText(element: XmlElement, memberPath?: string): string {
  let result = ""
  for (const child of element.children) {
    if (child.kind === "element") {
      throw xmlError(
        "MALFORMED_XML",
        `<${element.name}> contains nested markup where text was expected`,
        memberPath,
      )
    }
    result += child.value
  }
  return result
}

export function decodeXmlEntities(raw: string, memberPath?: string): string {
  if (!raw.includes("&")) return raw
  let result = ""
  let cursor = 0
  while (cursor < raw.length) {
    const ampersand = raw.indexOf("&", cursor)
    if (ampersand === -1) {
      result += raw.slice(cursor)
      break
    }
    result += raw.slice(cursor, ampersand)
    const semicolon = raw.indexOf(";", ampersand + 1)
    if (semicolon === -1) {
      throw xmlError("MALFORMED_XML", "Unterminated XML entity reference", memberPath)
    }
    const entity = raw.slice(ampersand + 1, semicolon)
    let decoded: string | undefined
    switch (entity) {
      case "amp":
        decoded = "&"
        break
      case "lt":
        decoded = "<"
        break
      case "gt":
        decoded = ">"
        break
      case "quot":
        decoded = `"`
        break
      case "apos":
        decoded = `'`
        break
      default: {
        const numeric = entity.match(/^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/)
        if (numeric) {
          const codePoint = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] ? 16 : 10)
          if (isValidXmlCodePoint(codePoint)) decoded = String.fromCodePoint(codePoint)
        }
      }
    }
    if (decoded === undefined) {
      throw xmlError("MALFORMED_XML", `Unsupported or invalid XML entity &${entity};`, memberPath)
    }
    result += decoded
    cursor = semicolon + 1
  }
  return result
}

export function escapeXmlText(value: string, memberPath?: string): string {
  validateXmlCharacters(value, memberPath)
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function parseDeclarationAttributes(body: string, memberPath?: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const attributeOrder: string[] = []
  let cursor = 0
  let parsedAttribute = false
  while (cursor < body.length) {
    const beforeWhitespace = cursor
    cursor = skipWhitespace(body, cursor)
    if (cursor >= body.length) break
    if (parsedAttribute && cursor === beforeWhitespace) {
      throw xmlError(
        "MALFORMED_XML",
        "XML declaration attributes must be separated by whitespace",
        memberPath,
      )
    }
    const name = readName(body, cursor, memberPath)
    cursor = skipWhitespace(body, name.end)
    if (body[cursor] !== "=") {
      throw xmlError("MALFORMED_XML", `Malformed XML declaration attribute ${name.name}`, memberPath)
    }
    cursor = skipWhitespace(body, cursor + 1)
    const quote = body[cursor]
    if (quote !== `"` && quote !== `'`) {
      throw xmlError("MALFORMED_XML", "XML declaration attributes must use quotes", memberPath)
    }
    const end = body.indexOf(quote, cursor + 1)
    if (end === -1) {
      throw xmlError("MALFORMED_XML", "Unterminated XML declaration attribute", memberPath)
    }
    if (attributes.has(name.name)) {
      throw xmlError("MALFORMED_XML", `Duplicate XML declaration attribute ${name.name}`, memberPath)
    }
    attributes.set(name.name, decodeXmlEntities(body.slice(cursor + 1, end), memberPath))
    attributeOrder.push(name.name)
    parsedAttribute = true
    cursor = end + 1
  }
  const version = attributes.get("version")
  if (!version || attributeOrder[0] !== "version") {
    throw xmlError("MALFORMED_XML", "XML declaration is missing its version", memberPath)
  }
  if (version !== "1.0") {
    throw xmlError("UNSAFE_XML_DECLARATION", `Unsupported XML version "${version}"`, memberPath)
  }
  for (const name of attributes.keys()) {
    if (name !== "version" && name !== "encoding" && name !== "standalone") {
      throw xmlError("MALFORMED_XML", `Unknown XML declaration attribute ${name}`, memberPath)
    }
  }
  const standalone = attributes.get("standalone")
  if (standalone && standalone !== "yes" && standalone !== "no") {
    throw xmlError(
      "MALFORMED_XML",
      `Invalid XML standalone declaration "${standalone}"`,
      memberPath,
    )
  }
  const encoding = attributes.get("encoding")
  if (encoding && !XML_DECLARATION_ENCODING.test(encoding)) {
    throw xmlError(
      "UNSAFE_XML_DECLARATION",
      `Unsupported XML encoding declaration "${encoding}"`,
      memberPath,
    )
  }
  return attributes
}

function readName(
  source: string,
  start: number,
  memberPath?: string,
): { name: string; end: number } {
  const first = source.codePointAt(start)
  if (first === undefined || !isXmlNameStart(first)) {
    throw xmlError("MALFORMED_XML", "Expected an XML name", memberPath)
  }
  let cursor = start + codePointLength(first)
  while (cursor < source.length) {
    const codePoint = source.codePointAt(cursor)
    if (codePoint === undefined || !isXmlNameCharacter(codePoint)) break
    cursor += codePointLength(codePoint)
  }
  return { name: source.slice(start, cursor), end: cursor }
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start
  while (
    source[cursor] === " " ||
    source[cursor] === "\t" ||
    source[cursor] === "\r" ||
    source[cursor] === "\n"
  ) {
    cursor += 1
  }
  return cursor
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":")
  return colon === -1 ? name : name.slice(colon + 1)
}

function isXmlNameStart(codePoint: number): boolean {
  return (
    codePoint === 0x3a ||
    codePoint === 0x5f ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0xc0 && codePoint <= 0xd6) ||
    (codePoint >= 0xd8 && codePoint <= 0xf6) ||
    (codePoint >= 0xf8 && codePoint <= 0x2ff) ||
    (codePoint >= 0x370 && codePoint <= 0x37d) ||
    (codePoint >= 0x37f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  )
}

function isXmlNameCharacter(codePoint: number): boolean {
  return (
    isXmlNameStart(codePoint) ||
    codePoint === 0x2d ||
    codePoint === 0x2e ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0xb7 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  )
}

function codePointLength(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1
}

function validateXmlCharacters(value: string, memberPath?: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || !isValidXmlCodePoint(codePoint)) {
      throw xmlError(
        "MALFORMED_XML",
        `Invalid XML character U+${(codePoint ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
        memberPath,
      )
    }
  }
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

function xmlError(
  code: "MALFORMED_XML" | "UNSAFE_XML_DECLARATION",
  message: string,
  memberPath?: string,
): IdmlError {
  const diagnostic: IdmlDiagnostic = {
    code,
    severity: "error",
    message,
    ...(memberPath ? { memberPath } : {}),
  }
  return new IdmlError(code, memberPath ? `${memberPath}: ${message}` : message, [diagnostic])
}
