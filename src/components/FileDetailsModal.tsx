import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface FileStats { translated: number; validated: number; total: number }

interface FileDetailsModalProps {
  file: FileReference | null
  open: boolean
  onOpenChange: (open: boolean) => void
  progress?: FileStats
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  )
}

/**
 * "File details" modal opened from a sidebar file row's ⋯ / right-click menu.
 * Metadata only — rename, move, export, and delete stay on the file menu.
 */
export function FileDetailsModal({
  file, open, onOpenChange, progress,
}: FileDetailsModalProps) {
  const t = useT()
  if (!file) return null

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : null
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : null

  const languages = [file.sourceLanguage, file.targetLanguage].filter(Boolean).join(" → ")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
          {file.originalName && file.originalName !== file.name && (
            <DialogDescription>{t("fileDetails.importedAs", { name: file.originalName })}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <dl className="divide-y divide-border/50 text-[13px]">
            <DetailRow label={t("fileDetails.type")}>{file.type.toUpperCase()}</DetailRow>
            {file.corpusMarker && <DetailRow label={t("fileDetails.corpus")}>{file.corpusMarker}</DetailRow>}
            {file.bookCode && <DetailRow label={t("fileDetails.bookCode")}>{file.bookCode}</DetailRow>}
            <DetailRow label={t("fileDetails.segments")}>{String(file.cellCount)}</DetailRow>
            <DetailRow label={t("fileDetails.ordering")}>
              {fileOrderedBy(file) === "time"
                ? t("fileDetails.orderingTimeline")
                : t("fileDetails.orderingSequence")}
            </DetailRow>
            {languages && <DetailRow label={t("fileDetails.languages")}>{languages}</DetailRow>}
            <DetailRow label={t("fileDetails.imported")}>
              {new Date(file.createdAt).toLocaleDateString(undefined, {
                year: "numeric", month: "short", day: "numeric",
              })}
            </DetailRow>
            {translatedPct !== null && validatedPct !== null && (
              <DetailRow label={t("fileDetails.progress")}>
                {t("fileDetails.progressValue", { translated: translatedPct, validated: validatedPct })}
              </DetailRow>
            )}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
