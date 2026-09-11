import { toast } from "@/components/ui/toast"
import {
  downloadOriginalFile,
  downloadOriginalsZip,
  originalDownloadLabel,
  OriginalDownloadError,
} from "@/lib/sync/original-download"
import { t } from "@/lib/i18n/standalone"

function toastOriginalError(err: unknown): void {
  const missing = err instanceof OriginalDownloadError && err.status === 404
  toast.add({
    type: "error",
    priority: "high",
    title: missing
      ? t("importExport.errors.originalMissing")
      : err instanceof Error
        ? err.message
        : t("importExport.status.exportFailed"),
  })
}

/** Click handler: same shape as `exportSourceFile` (mint → fetch → blob save). */
export async function downloadImportedOriginal(args: {
  projectId: string
  file: { id: string; name: string; type: string; originalName?: string }
  getToken: (fileId: string) => Promise<string | null>
}): Promise<void> {
  const downloadName = originalDownloadLabel(args.file.name, args.file.type, args.file.originalName)
  try {
    await downloadOriginalFile({
      projectId: args.projectId,
      fileId: args.file.id,
      downloadName,
      getToken: args.getToken,
    })
  } catch (err) {
    toastOriginalError(err)
  }
}

/** Click handler: same shape as `downloadProjectBundle`. */
export async function downloadImportedOriginalsZip(args: {
  projectId: string
  projectName: string
  jwt: string
  fileId: string
}): Promise<void> {
  try {
    await downloadOriginalsZip(args)
  } catch (err) {
    toastOriginalError(err)
  }
}
