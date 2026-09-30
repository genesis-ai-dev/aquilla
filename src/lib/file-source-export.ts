// AQU-1449: the File menu's "Export source (.SFM)" downloads the CURATED
// SOURCE — the original upload with source edits applied, hidden and deleted
// cells dropped, and added cells' source text in place — so a lead can re-import
// a file they curated as the source of another project.
//
// It used to return the active lane's translation injected into the upload,
// which is what the Export dialog's own "Download (file name)" button already
// gives you: the menu item was a second copy of the target export under a name
// that promised the source. That dialog path is untouched (`side` omitted =
// target), because nothing may produce both sides at once.

import { toast } from "@/components/ui/toast"
import type { FileReference } from "@/lib/parsers/types"
import { downloadSourceFile, SourceExportError } from "@/lib/sync/source-export"
import { t } from "@/lib/i18n/standalone"

export const EXPORTABLE_SOURCE_FILE_TYPES: ReadonlySet<FileReference["type"]> = new Set(["usfm"])

export function canExportSourceFile(file: FileReference, canExportByOrgPolicy: boolean): boolean {
  return EXPORTABLE_SOURCE_FILE_TYPES.has(file.type) && canExportByOrgPolicy
}

export function sourceExportDownloadName(fileName: string): string {
  return /\.(sfm|usfm)$/i.test(fileName) ? fileName : `${fileName}.SFM`
}

export async function exportSourceFile(args: {
  projectId: string
  file: FileReference
  getToken: (fileId: string) => Promise<string | null>
}): Promise<void> {
  const name = sourceExportDownloadName(args.file.name)
  try {
    await downloadSourceFile({
      projectId: args.projectId,
      fileId: args.file.id,
      downloadName: name,
      getToken: args.getToken,
      // No lane: the source side is the same file whichever lane is active.
      side: "source",
    })
    toast.add({ type: "success", title: t("importExport.status.exportedFile", { fileName: name }) })
  } catch (err) {
    const msg =
      err instanceof SourceExportError && err.status === 404
        ? "This file was imported before round-trip export was wired up. Re-import to enable it."
        : err instanceof Error
          ? `Export failed: ${err.message}`
          : "Export failed."
    toast.add({ type: "error", priority: "high", title: msg })
  }
}
