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
import { exportPlainText } from "./exporters/plaintext"
import { exportMarkdown } from "./exporters/markdown"
import { exportTsv } from "./exporters/tsv"
import { exportCsv } from "./exporters/csv"
import { exportXliff } from "./exporters/xliff"
import { exportTmx } from "./exporters/tmx"

/** Formats handled by the project-zip path (excludes server-side USFM,
 *  audio-by-character which has its own orchestrator, and vtt which needs
 *  per-project ttsSettings not available in the zip path). */
export type TextExportFormat = Exclude<ExportFormat, "usfm" | "audio-by-character" | "vtt">

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
    case "txt": return exportPlainText(cells)
    case "md":  return exportMarkdown(cells)
    case "tsv": return exportTsv(cells)
    case "csv": return exportCsv(cells)
    case "xlf": return exportXliff(cells, sourceLanguage, targetLanguage)
    case "tmx": return exportTmx(cells, sourceLanguage, targetLanguage)
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
