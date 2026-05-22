// Phase 2c-γ: Export was driven by the per-file Y.Doc cache (collectExportCells)
// and per-file blob lookups (project-index). Both went away with the Y.Doc rip.
// Re-implementing export on the D1 cells projection + R2 source blobs is its
// own event-grammar exercise, deferred to v1.x. The export buttons in the UI
// still wire to this function; calling it now fails loudly so we don't silently
// produce empty files.

import posthog from "@/lib/posthog"

export interface ExportData {
  fileName: string
  fileType: string
  cells: unknown[]
}

export interface ExportResult {
  blob: Blob
  filename: string
}

export async function exportFile(_fileId: string): Promise<ExportResult> {
  throw new Error(
    "Export disabled in Phase 2c-γ — coming back via event-grammar in v1.x",
  )
}

export function downloadBlob(blob: Blob, filename: string): void {
  const extension = filename.split(".").pop() ?? "unknown"
  posthog.capture("file exported", { filename, file_type: extension })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
