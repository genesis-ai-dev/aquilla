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

      const text = blockCells
        .map((c) => (c.translated.trim() ? c.translated : c.original))
        .join(" ")

      replaceBlockText(blockElement, text, fileType)
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

function replaceBlockText(block: Element, newText: string, fileType: "docx" | "pptx"): void {
  const doc = block.ownerDocument!
  const runTag = fileType === "docx" ? "w:r" : "a:r"
  const textTag = fileType === "docx" ? "w:t" : "a:t"

  // Remove all existing runs (descendant + direct)
  const runs = Array.from(block.getElementsByTagName(runTag))
  for (const run of runs) {
    run.parentNode?.removeChild(run)
  }

  const newRun = doc.createElement(runTag)
  const newTextEl = doc.createElement(textTag)
  if (fileType === "docx") {
    newTextEl.setAttribute("xml:space", "preserve")
  }
  newTextEl.textContent = newText
  newRun.appendChild(newTextEl)
  block.appendChild(newRun)
}
