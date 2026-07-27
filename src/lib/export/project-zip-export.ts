/**
 * buildProjectZip — aggregate per-file cells into a single zip Blob.
 *
 * Pure async function (no React): takes the already-fetched per-file cell
 * data, runs the appropriate exporter on each file's cells, and bundles the
 * results into a JSZip archive. One entry per file, named
 * `<fileName (no original ext)>.<formatExt>`.
 *
 * Called from ExportDialog after useProjectCells has loaded all file cells.
 */

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { ExportFormat } from "@/components/ExportDialog"
import { exportPlainTextStructured } from "./exporters/plaintext"
import { exportMarkdownStructured } from "./exporters/markdown"
import { exportTsv } from "./exporters/tsv"
import { exportCsv } from "./exporters/csv"
import { exportXliff12Structured } from "./exporters/xliff12-structured"
import { exportTmxStructured } from "./exporters/tmx-structured"
import { exportSrt } from "./exporters/srt"

/** Formats handled by the project-zip path (excludes server-side USFM,
 *  audio-by-character which has its own orchestrator, vtt which needs
 *  per-project ttsSettings not available in the zip path, docx/pptx which
 *  require the raw sidecar bytes from the server, plain-text-dump which
 *  is advanced/single-file only, and metadata-csv which has its own
 *  project-scope path in ExportDialog that flattens all cells into one sheet). */
export type TextExportFormat = Exclude<ExportFormat, "usfm" | "audio-by-character" | "vtt" | "docx" | "pptx" | "idml" | "plain-text-dump" | "metadata-csv" | "sdbh-xml">

export interface ProjectFileCellsInput {
  fileId: string
  fileName: string
  cells: CellData[]
}

const FORMAT_EXT: Record<TextExportFormat, string> = {
  txt: ".txt",
  md: ".md",
  tsv: ".tsv",
  csv: ".csv",
  xlf: ".xlf",
  tmx: ".tmx",
  srt: ".srt",
}

/**
 * Run the exporter for a single file's cells.
 */
export function exportFileCells(
  cells: CellData[],
  format: TextExportFormat,
  sourceLanguage: string,
  targetLanguage: string,
): Blob {
  switch (format) {
    case "txt": return exportPlainTextStructured(cells)
    case "md":  return exportMarkdownStructured(cells)
    case "tsv": return exportTsv(cells)
    case "csv": return exportCsv(cells)
    case "xlf": return exportXliff12Structured(cells, sourceLanguage, targetLanguage)
    case "tmx": return exportTmxStructured(cells, sourceLanguage, targetLanguage)
    case "srt": return exportSrt(cells)
    default: {
      // TypeScript exhaustiveness guard — should never happen at runtime.
      const _never: never = format
      throw new Error(`Unknown export format: ${_never}`)
    }
  }
}

export interface BuildProjectZipOptions {
  files: ProjectFileCellsInput[]
  format: TextExportFormat
  sourceLanguage?: string
  targetLanguage?: string
}

/**
 * Build a zip Blob with one exported file per project file.
 * Files with zero cells are included (exporters handle empty arrays gracefully).
 */
export async function buildProjectZip(opts: BuildProjectZipOptions): Promise<Blob> {
  const { files, format, sourceLanguage = "und", targetLanguage = "und" } = opts
  const ext = FORMAT_EXT[format]
  const zip = new JSZip()

  for (const f of files) {
    const baseName = f.fileName.replace(/\.[^.]+$/, "")
    const entryName = `${baseName}${ext}`
    const blob = exportFileCells(f.cells, format, sourceLanguage, targetLanguage)
    // JSZip accepts Blob directly in browser environments.
    zip.file(entryName, blob)
  }

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" })
}
