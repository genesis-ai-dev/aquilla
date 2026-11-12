// Structural validity of an exported Word part, in the spirit of the review's
// check_structure.py (AQU-2539): what Word needs beyond well-formed XML. Used
// by the exporter tests on every synthetic export. Returns the problems found.
//
// Checked: a table cell ends with a paragraph; a text box holds one; every
// bookmark has exactly one start and one end, start first; field characters
// balance (begin, separate, end) across the part and field instructions sit in
// an open field code; REF/PAGEREF/NOTEREF fields name a bookmark that exists;
// every footnote reference names a note that exists, once; a hyperlink holds a
// run; runs and paragraphs sit where WordprocessingML allows them; a run's
// properties are in schema order with no property twice. Not flagged: an
// emptied simple field or content control (schema-valid, by design).
import { elementsByTagName, getAttribute, isElement, parseXmlLite, textContent, type XmlElement } from "@/lib/parsers/xml-lite"

const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
  "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden",
  "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect",
  "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath", "rPrChange",
]
const RUN_PARENTS = new Set(["w:p", "w:hyperlink", "w:fldSimple", "w:smartTag", "w:customXml", "w:sdtContent", "w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:dir", "w:bdo"])
const P_PARENTS = new Set(["w:body", "w:tc", "w:txbxContent", "w:sdtContent", "w:footnote", "w:endnote", "w:comment", "w:hdr", "w:ftr", "w:customXml", "w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:docPartBody"])

const elementChildren = (el: XmlElement) => el.children.filter(isElement)

export function structuralProblems(partXml: string, footnotesXml?: string): string[] {
  const problems: string[] = []
  const root = parseXmlLite(partXml)

  const walk = (el: XmlElement, parent: XmlElement | null) => {
    if (el.tagName === "w:r" && parent && !RUN_PARENTS.has(parent.tagName)) problems.push(`w:r under ${parent.tagName}`)
    if (el.tagName === "w:p" && parent && !P_PARENTS.has(parent.tagName)) problems.push(`w:p under ${parent.tagName}`)
    if (el.tagName === "w:tc") {
      const kids = elementChildren(el).filter((c) => c.tagName !== "w:tcPr")
      if (kids.length === 0 || kids[kids.length - 1].tagName !== "w:p") problems.push("w:tc not ending in w:p")
    }
    if (el.tagName === "w:txbxContent" && !elementChildren(el).some((c) => c.tagName === "w:p")) problems.push("w:txbxContent with no paragraph")
    if (el.tagName === "w:hyperlink" && elementsByTagName(el, "w:r").length === 0) problems.push("w:hyperlink with no run")
    if (el.tagName === "w:rPr" && parent?.tagName === "w:r") {
      const names = elementChildren(el).map((c) => c.tagName.replace(/^w:/, ""))
      const ranks = names.map((n) => RPR_ORDER.indexOf(n)).filter((r) => r >= 0)
      if (ranks.some((r, k) => k > 0 && r < ranks[k - 1])) problems.push(`w:rPr children out of order: ${names.join(",")}`)
      if (new Set(names).size !== names.length) problems.push(`w:rPr child repeated: ${names.join(",")}`)
    }
    for (const child of elementChildren(el)) walk(child, el)
  }
  walk(root, null)

  // Bookmarks, in document order.
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()
  const names = new Set<string>()
  let order = 0
  const visitBookmarks = (el: XmlElement) => {
    for (const child of elementChildren(el)) {
      order++
      if (child.tagName === "w:bookmarkStart") {
        const id = getAttribute(child, "w:id") ?? ""
        if (starts.has(id)) problems.push(`bookmarkStart id repeated: ${id}`)
        starts.set(id, order)
        const name = getAttribute(child, "w:name")
        if (name) names.add(name)
      } else if (child.tagName === "w:bookmarkEnd") {
        const id = getAttribute(child, "w:id") ?? ""
        if (ends.has(id)) problems.push(`bookmarkEnd id repeated: ${id}`)
        ends.set(id, order)
      }
      visitBookmarks(child)
    }
  }
  visitBookmarks(root)
  for (const [id, at] of starts) {
    if (!ends.has(id)) problems.push(`bookmarkStart with no end: ${id}`)
    else if (ends.get(id)! < at) problems.push(`bookmarkEnd before its start: ${id}`)
  }
  for (const id of ends.keys()) if (!starts.has(id)) problems.push(`bookmarkEnd with no start: ${id}`)

  // Fields: one stack across the part (a contents field spans paragraphs).
  const stack: ("code" | "result")[] = []
  const visitFields = (el: XmlElement) => {
    for (const child of elementChildren(el)) {
      if (child.tagName === "w:fldChar") {
        const type = getAttribute(child, "w:fldCharType")
        if (type === "begin") stack.push("code")
        else if (type === "separate") {
          if (stack[stack.length - 1] !== "code") problems.push("field separate without an open field code")
          else stack[stack.length - 1] = "result"
        } else if (type === "end") {
          if (stack.length === 0) problems.push("field end without begin")
          else stack.pop()
        }
      } else if (child.tagName === "w:instrText") {
        if (stack[stack.length - 1] !== "code") problems.push("instrText outside a field code")
        const ref = /^\s*(REF|PAGEREF|NOTEREF)\s+(\S+)/i.exec(textContent(child))
        if (ref && !names.has(ref[2])) problems.push(`${ref[1]} to a missing bookmark: ${ref[2]}`)
      }
      visitFields(child)
    }
  }
  visitFields(root)
  if (stack.length > 0) problems.push(`field begin without end (${stack.length})`)

  // Footnote references.
  if (footnotesXml !== undefined) {
    const notes = new Set(elementsByTagName(parseXmlLite(footnotesXml), "w:footnote").map((n) => getAttribute(n, "w:id")))
    const seen = new Set<string>()
    for (const ref of elementsByTagName(root, "w:footnoteReference")) {
      const id = getAttribute(ref, "w:id") ?? ""
      if (!notes.has(id)) problems.push(`footnoteReference to a missing note: ${id}`)
      if (seen.has(id)) problems.push(`footnote referenced twice: ${id}`)
      seen.add(id)
    }
  }
  return problems
}
