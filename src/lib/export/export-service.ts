import { collectExportCells, type ExportData } from "@/lib/store/file-doc"
import { getOriginalFile } from "@/lib/store/project-index"
import { surgicalExport } from "./surgical-export"
import { rebuildPlaintext } from "./rebuilders/plaintext"
import { rebuildMarkdown } from "./rebuilders/markdown"
import { rebuildVtt, rebuildSrt } from "./rebuilders/subtitle"
import { rebuildUsfm } from "./rebuilders/usfm"

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  vtt: "text/vtt",
  srt: "application/x-subrip",
  usfm: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export interface ExportResult {
  blob: Blob
  filename: string
}

export async function exportFile(fileId: string): Promise<ExportResult> {
  const data = await collectExportCells(fileId)
  const { fileName, fileType, cells } = data

  const extension = fileType
  const baseName = stripExtension(fileName)
  const filename = `${baseName}.translated.${extension}`

  if (fileType === "docx" || fileType === "pptx") {
    const original = await getOriginalFile(fileId)
    const hasLocations = cells.some((c) => c.sourceLocation)
    if (original && hasLocations) {
      const buffer = await surgicalExport(original, cells, fileType)
      return {
        blob: new Blob([buffer], { type: MIME_TYPES[fileType] }),
        filename,
      }
    }
    const text = rebuildPlaintext(cells)
    return {
      blob: new Blob([text], { type: "text/plain" }),
      filename: `${baseName}.translated.txt`,
    }
  }

  let content: string
  switch (fileType) {
    case "txt":
      content = rebuildPlaintext(cells)
      break
    case "md":
      content = rebuildMarkdown(cells)
      break
    case "vtt":
      content = rebuildVtt(cells)
      break
    case "srt":
      content = rebuildSrt(cells)
      break
    case "usfm":
      content = rebuildUsfm(cells)
      break
    default:
      content = rebuildPlaintext(cells)
  }

  return {
    blob: new Blob([content], { type: MIME_TYPES[fileType] || "text/plain" }),
    filename,
  }
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot <= 0) return filename
  return filename.slice(0, lastDot)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export type { ExportData }
