import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy } from "@/lib/parsers/types"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { bidiIsolate, formatDate, formatNumber } from "@/lib/i18n/format"
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
      <dd className="min-w-0 truncate text-end" title={typeof children === "string" ? children : undefined}>
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
  const { t, locale } = useI18n()
  if (!file) return null

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : null
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pe-8">{file.name}</DialogTitle>
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
            {file.sourceLanguage && (
              <DetailRow label={t("fileDetails.sourceLanguage")}>{file.sourceLanguage}</DetailRow>
            )}
            <DetailRow label={t("fileDetails.imported")}>
              {formatDate(file.createdAt, locale, { year: "numeric", month: "short", day: "numeric" })}
            </DetailRow>
            {translatedPct !== null && validatedPct !== null && (
              <DetailRow label={t("fileDetails.progress")}>
                {t("fileDetails.progressValue", {
                  translated: bidiIsolate(formatNumber(translatedPct, locale)),
                  validated: bidiIsolate(formatNumber(validatedPct, locale)),
                })}
              </DetailRow>
            )}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
