import { toast } from "sonner"
import type { FileReference } from "@/lib/parsers/types"
import { downloadSourceFile, SourceExportError } from "@/lib/sync/source-export"

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
  targetLang?: string
}): Promise<void> {
  const name = sourceExportDownloadName(args.file.name)
  try {
    await downloadSourceFile({
      projectId: args.projectId,
      fileId: args.file.id,
      downloadName: name,
      getToken: args.getToken,
      targetLang: args.targetLang ?? "",
    })
    toast.success(`Exported ${name}`)
  } catch (err) {
    const msg =
      err instanceof SourceExportError && err.status === 404
        ? "This file was imported before round-trip export was wired up. Re-import to enable it."
        : err instanceof Error
          ? `Export failed: ${err.message}`
          : "Export failed."
    toast.error(msg)
  }
}
