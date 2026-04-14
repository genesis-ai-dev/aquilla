import JSZip from "jszip"
import type { ExportCell } from "@/lib/store/file-doc"

export async function surgicalExport(
  originalBuffer: ArrayBuffer,
  cells: ExportCell[],
  fileType: "docx" | "pptx"
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(originalBuffer)

  // Group cells by file, then by blockPath
  const byFile = new Map<string, Map<string, ExportCell[]>>()

  for (const cell of cells) {
    if (!cell.sourceLocation) continue
    const { file, blockPath } = cell.sourceLocation
    let byBlock = byFile.get(file)
    if (!byBlock) {
      byBlock = new Map<string, ExportCell[]>()
      byFile.set(file, byBlock)
    }
    const existing = byBlock.get(blockPath) || []
    existing.push(cell)
    byBlock.set(blockPath, existing)
  }

  for (const [filePath, blockMap] of byFile) {
    const file = zip.file(filePath)
    if (!file) continue

    const xmlStr = await file.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

    // Process blocks in reverse order for predictability
    const blockPaths = Array.from(blockMap.keys()).sort((a, b) => b.localeCompare(a))

    for (const blockPath of blockPaths) {
      const blockCells = blockMap.get(blockPath)!
      const blockElement = findBlock(doc, blockPath)
      if (!blockElement) continue

      // Build rich runs from each cell's fragment HTML (preserving inline
      // formatting). If no rich text is present, fall back to plain text.
      const runs = buildRunsForBlock(blockCells)
      replaceBlockRuns(blockElement, runs, fileType)
    }

    const serialized = new XMLSerializer().serializeToString(doc)
    zip.file(filePath, serialized)
  }

  return zip.generateAsync({ type: "arraybuffer" })
}

function findBlock(doc: Document, blockPath: string): Element | null {
  const segments = blockPath.split("/")
  const docxBodies = doc.getElementsByTagName("w:body")
  const pptxTrees = doc.getElementsByTagName("p:spTree")
  let current: Element | Document = doc
  if (docxBodies.length > 0) current = docxBodies[0]
  else if (pptxTrees.length > 0) current = pptxTrees[0]

  for (const segment of segments) {
    const match = segment.match(/^([^[]+)(?:\[(\d+)\])?$/)
    if (!match) return null
    const tag = match[1]
    const index = match[2] ? parseInt(match[2]) : 1

    const children = getChildrenByTagName(current as Element, tag)
    if (index < 1 || index > children.length) return null
    current = children[index - 1]
  }

  return current as Element
}

function getChildrenByTagName(parent: Element, tagName: string): Element[] {
  const result: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i]
    if (node.nodeType === 1 && (node as Element).nodeName === tagName) {
      result.push(node as Element)
    }
  }
  return result
}

// A single styled text run extracted from a cell's rich-text fragment.
interface StyledRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
}

// Convert each cell's translatedHtml (from M9 rich text fragment) into a flat
// list of styled runs. Cells are joined with a space separator. Fallback to
// plain text (as a single unformatted run) when no HTML is available.
function buildRunsForBlock(cells: ExportCell[]): StyledRun[] {
  const runs: StyledRun[] = []
  cells.forEach((cell, idx) => {
    if (idx > 0) runs.push({ text: " " })
    const hasText = cell.translated.trim()
    if (!hasText) {
      runs.push({ text: cell.original })
      return
    }
    if (cell.translatedHtml) {
      runs.push(...parseHtmlToRuns(cell.translatedHtml))
    } else {
      runs.push({ text: cell.translated })
    }
  })
  return runs
}

function parseHtmlToRuns(html: string): StyledRun[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  const runs: StyledRun[] = []
  walkHtmlForRuns(doc.body, {}, runs)
  return runs
}

function walkHtmlForRuns(el: Element, marks: Omit<StyledRun, "text">, out: StyledRun[]): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.nodeValue || ""
      if (text.length > 0) out.push({ text, ...marks })
    } else if (child.nodeType === 1) {
      const childEl = child as Element
      const tag = childEl.tagName.toLowerCase()
      if (tag === "br") {
        out.push({ text: "\n", ...marks })
      } else if (tag === "p") {
        walkHtmlForRuns(childEl, marks, out)
        // Insert a soft line break between paragraphs to separate them within a block.
        out.push({ text: "\n", ...marks })
      } else if (tag === "b" || tag === "strong") {
        walkHtmlForRuns(childEl, { ...marks, bold: true }, out)
      } else if (tag === "i" || tag === "em") {
        walkHtmlForRuns(childEl, { ...marks, italic: true }, out)
      } else if (tag === "u") {
        walkHtmlForRuns(childEl, { ...marks, underline: true }, out)
      } else if (tag === "s" || tag === "strike" || tag === "del") {
        walkHtmlForRuns(childEl, { ...marks, strike: true }, out)
      } else if (tag === "code") {
        walkHtmlForRuns(childEl, { ...marks, code: true }, out)
      } else {
        // Unknown inline tag — drop wrapper, keep content
        walkHtmlForRuns(childEl, marks, out)
      }
    }
  }
}

const DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

function replaceBlockRuns(block: Element, runs: StyledRun[], fileType: "docx" | "pptx"): void {
  const doc = block.ownerDocument!
  const runTag = fileType === "docx" ? "w:r" : "a:r"

  // Remove all existing runs (descendant + direct)
  const existing = Array.from(block.getElementsByTagName(runTag))
  for (const run of existing) {
    run.parentNode?.removeChild(run)
  }

  // Filter trailing empty whitespace runs
  const cleaned = runs.filter((r, i) =>
    r.text.length > 0 || (i > 0 && i < runs.length - 1)
  )

  for (const run of cleaned) {
    const el = fileType === "docx" ? buildDocxRun(doc, run) : buildPptxRun(doc, run)
    block.appendChild(el)
  }
}

// Create a prefixed element in the given namespace. Using createElementNS with
// a qualifiedName that includes the prefix keeps the `w:`/`a:` prefix in
// serialized output, reusing the existing xmlns:w / xmlns:a on the root.
function makePrefixed(doc: Document, ns: string, qualifiedName: string): Element {
  return doc.createElementNS(ns, qualifiedName)
}

function setPrefixedAttr(ns: string, el: Element, qualifiedName: string, value: string): void {
  el.setAttributeNS(ns, qualifiedName, value)
}

function buildDocxRun(doc: Document, run: StyledRun): Element {
  const r = makePrefixed(doc, DOCX_NS, "w:r")
  const hasMarks = run.bold || run.italic || run.underline || run.strike || run.code
  if (hasMarks) {
    const rPr = makePrefixed(doc, DOCX_NS, "w:rPr")
    if (run.bold) rPr.appendChild(makePrefixed(doc, DOCX_NS, "w:b"))
    if (run.italic) rPr.appendChild(makePrefixed(doc, DOCX_NS, "w:i"))
    if (run.underline) {
      const u = makePrefixed(doc, DOCX_NS, "w:u")
      setPrefixedAttr(DOCX_NS, u, "w:val", "single")
      rPr.appendChild(u)
    }
    if (run.strike) rPr.appendChild(makePrefixed(doc, DOCX_NS, "w:strike"))
    if (run.code) {
      const fonts = makePrefixed(doc, DOCX_NS, "w:rFonts")
      setPrefixedAttr(DOCX_NS, fonts, "w:ascii", "Consolas")
      setPrefixedAttr(DOCX_NS, fonts, "w:hAnsi", "Consolas")
      rPr.appendChild(fonts)
    }
    r.appendChild(rPr)
  }
  const t = makePrefixed(doc, DOCX_NS, "w:t")
  // xml:space is a reserved XML attribute, not in the DOCX namespace
  t.setAttribute("xml:space", "preserve")
  t.textContent = run.text
  r.appendChild(t)
  return r
}

function buildPptxRun(doc: Document, run: StyledRun): Element {
  const r = makePrefixed(doc, DRAWING_NS, "a:r")
  const rPr = makePrefixed(doc, DRAWING_NS, "a:rPr")
  rPr.setAttribute("lang", "en-US")
  if (run.bold) rPr.setAttribute("b", "1")
  if (run.italic) rPr.setAttribute("i", "1")
  if (run.underline) rPr.setAttribute("u", "sng")
  if (run.strike) rPr.setAttribute("strike", "sngStrike")
  r.appendChild(rPr)
  const t = makePrefixed(doc, DRAWING_NS, "a:t")
  t.textContent = run.text
  r.appendChild(t)
  return r
}
